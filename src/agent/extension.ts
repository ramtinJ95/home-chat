// Home Chat's tools, rules and instructions as one Pi Durable extension. Every conversation runs with exactly this
// extension, so the model has these eight tools and nothing else: no read, write, edit or bash.
import type { Context } from '@earendil-works/chord/context';
import type { ImageContent, MutableModels } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, hook, section, ToolTask, type ConversationId } from '@earendil-works/pi-durable';
import type { Question } from '../api.d.ts';
import { TURN_LIMITS, refusedInTurn, validateToolInput, type ServerCall, type TurnMode } from '../policy.ts';
import * as ask from './tools/ask.ts';
import * as deepResearch from './tools/deep-research.ts';
import * as document from './tools/document.ts';
import * as imagegen from './tools/imagegen.ts';
import * as memory from './tools/memory.ts';
import * as routine from './tools/routine.ts';
import * as todo from './tools/todo.ts';
import * as webRun from './tools/web-run.ts';

// What the tools need from the conversation they run in (src/agent/worker.ts).
export interface ChatHost {
  // The Home Chat conversation's id, which outlives the forks regenerate and edit make.
  readonly chat: string;
  readonly cwd: string;
  // The current turn's mode, and its tool calls and image requests so far.
  readonly turn: {mode: TurnMode; calls: number; images: number};
  readonly call: ServerCall;
  // Shows the question in the app; resolves with the answer, or undefined when it was dismissed or `signal` aborted.
  dialog(question: Omit<Question, 'id'>, signal: AbortSignal | undefined): Promise<string | boolean | undefined>;
  // The conversation's newest `count` images, oldest first.
  recentImages(count: number, context: Context): Promise<ImageContent[]>;
}

const text = (value: string) => [{type: 'text' as const, text: value}];
const NOTES_UNAVAILABLE = 'The household notes (About us) could not be loaded for this message. '
  + 'If the user refers to something they asked you to remember, say that you cannot see the notes right now.\n';

export function homeExtension({models, instructions, hostFor}:
  {models: MutableModels; instructions: string; hostFor: (conversation: ConversationId) => ChatHost | undefined}) {
  const host = (conversation: ConversationId) => {
    const found = hostFor(conversation);
    if (!found) throw new Error('Home Chat is not available in this conversation right now');
    return found;
  };

  const tools = [
    defineTool({
      name: 'ask', description: ask.description, parameters: ask.parameters,
      // One question at a time: the app shows a single question, so a second asked alongside would never be answered.
      executionMode: 'sequential',
      async execute(args, api, context) {
        const chat = host(api.conversationId);
        const answer = await ask.ask(args, question => chat.dialog(question, context.abortSignal));
        return {output: text(answer ?? 'Dismissed by user.')};
      },
    }),
    defineTool({
      name: 'web_run', description: webRun.description, parameters: webRun.parameters,
      async execute(args, api, context) {
        // One id for all of the conversation's calls, forks included, so refs from earlier calls keep working.
        return {output: text(await webRun.webRun(models, host(api.conversationId).chat, args, context.abortSignal))};
      },
    }),
    defineTool({
      name: 'imagegen', description: imagegen.description, parameters: imagegen.parameters,
      async execute(args, api, context) {
        const chat = host(api.conversationId);
        return imagegen.imagegen(models, chat.cwd, api.callId, args, count => chat.recentImages(count, context), context.abortSignal);
      },
    }),
    defineTool({
      name: 'document', description: document.description, parameters: document.parameters,
      async execute(args, api) {
        const {text: saved, doc, version} = await document.saveDocument(args, host(api.conversationId).cwd);
        return {output: text(saved), details: {doc, version}};
      },
    }),
    defineTool({
      name: 'deep_research', description: deepResearch.description, parameters: deepResearch.parameters,
      async execute(args, _api, context) { return deepResearch.research(args, context.abortSignal); },
    }),
    defineTool({
      name: 'routine', description: routine.description, parameters: routine.parameters,
      async execute(args, api) { return {output: text(await host(api.conversationId).call('/routine', args))}; },
    }),
    defineTool({
      name: 'todo', description: todo.description, parameters: todo.parameters,
      async execute(args, api) { return {output: text(await host(api.conversationId).call('/todo', args))}; },
    }),
    defineTool({
      name: 'memory', description: memory.description, parameters: memory.parameters,
      executionMode: 'sequential',
      async execute(args, api, context) {
        const chat = host(api.conversationId);
        // Dismissing the question, or stopping the turn, counts as no.
        const confirm = async (title: string, message: string) =>
          await chat.dialog({method: 'confirm', title, message, options: [], prefill: ''}, context.abortSignal) === true;
        return {output: text(await memory.changeMemory(args, chat.call, confirm))};
      },
    }),
  ];

  return defineExtension({
    name: 'home-chat',
    tools,
    sections: [
      section('home-chat', () => instructions, {tag: false}),
      // The household notes as they are now, so an edit under About us counts from the next request on.
      section('household', async input => {
        const chat = hostFor(input.conversationId);
        if (!chat) return undefined;
        return await chat.call('/memory').catch(() => NOTES_UNAVAILABLE) || undefined;
      }, {tag: false}),
    ],
    hooks: [hook(ToolTask, {
      // Every call passes here before it runs: the turn's mode, the input checks and the per-message limits.
      async beforeTool(call, api) {
        const chat = hostFor(api.conversationId);
        if (!chat) return {block: 'Home Chat is not available in this conversation right now'};
        const {turn} = chat;
        const refused = refusedInTurn(call.name, {deepResearch: turn.mode.deepResearch === true, routineRun: turn.mode.routineRun !== undefined});
        if (refused) return {block: refused};
        try { await validateToolInput(call.name, call.arguments, chat.cwd); }
        catch (error) { return {block: (error as Error).message}; }
        if (++turn.calls > TURN_LIMITS[turn.mode.deepResearch ? 'deep' : 'normal'].toolCalls) return {block: 'Tool-call limit reached for this message'};
        if (call.name === 'imagegen' && ++turn.images > 2) return {block: 'Two image requests per message maximum'};
        return undefined;
      },
    })],
  });
}
