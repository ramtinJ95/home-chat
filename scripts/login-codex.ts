import { codexModels } from '../src/agent/codex.ts';
const models = codexModels('/data/profile/auth.json');
try {
  await models.login('openai-codex', 'oauth', {
    signal: AbortSignal.timeout(12 * 60_000),
    prompt: async question => {
      if (question.type === 'select' && question.options.some(option => option.id === 'device_code')) return 'device_code';
      throw new Error('This helper supports device-code login only');
    },
    notify: event => {
      if (event.type === 'device_code') console.log(JSON.stringify({verificationUri: event.verificationUri, userCode: event.userCode, expiresInSeconds: event.expiresInSeconds}));
    },
  });
  console.log('Codex login saved in the isolated profile. No credentials were printed.');
} catch (error) {
  // Never print provider response bodies or OAuth credential objects.
  console.error('Codex device login did not complete: ' + ((error as Error).name ?? 'Error'));
  process.exitCode = 1;
}
