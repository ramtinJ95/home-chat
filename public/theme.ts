// A classic script in <head>: it runs before the first paint, so a saved theme never flashes the other one.
// Without a saved choice the page follows the system setting; the sidebar button saves an explicit light or dark.
// The block keeps these names out of the global scope.
{
  type Theme = 'light' | 'dark';
  const KEY = 'home-chat-theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const current = (): Theme => root.dataset.theme === 'light' || root.dataset.theme === 'dark'
    ? root.dataset.theme
    : system.matches ? 'dark' : 'light';

  const render = () => {
    // The browser chrome matches the page; style.css has loaded by now (it blocks this script) and owns the colours.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).backgroundColor);
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} mode`);
    button.title = `Switch to ${next} mode`;
    button.querySelector('use')?.setAttribute('href', next === 'dark' ? '#moon' : '#sun');
  };

  system.addEventListener('change', render);
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    if (button) button.onclick = () => {
      const next: Theme = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem(KEY, next);
      render();
    };
    render();
  });
  render();
}
