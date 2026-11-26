// Chrome provides an install prompt when its installability requirements are met.
let installPrompt;
const installButton = document.getElementById('installButton');
const installHelp = document.getElementById('installHelp');
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
installButton.addEventListener('click', async () => {
  if (!installPrompt) { installHelp.classList.remove('hidden'); return; }
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  await prompt.userChoice;
});
window.addEventListener('appinstalled', () => { installButton.hidden = true; installHelp.classList.add('hidden'); });
if (window.matchMedia('(display-mode: standalone)').matches) installButton.hidden = true;
