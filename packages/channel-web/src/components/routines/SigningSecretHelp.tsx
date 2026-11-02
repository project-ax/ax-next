/**
 * What a saved signing secret does, shown next to the Signing secret row on the task page and in
 * Settings (TASK-1026). A routine with a legacy signature setting (`webhook.hmac`) always checks, so
 * its help never says updates go unchecked, and it says how to stop: removing app updates clears the
 * setting and the saved secret, and adding them back issues a new address once the old secret is gone.
 * A routine with no schedule can't save without app updates ("Choose a schedule or updates from another
 * app"), so for it the only way out is a fresh routine, which gets its own address and secret slot.
 */
export function SigningSecretHelp({ legacy, scheduled, noun }: { legacy: boolean; scheduled: boolean; noun: 'task' | 'routine' }) {
  const howToStop = scheduled
    ? 'To stop checking, turn off its app updates and save, then turn them back on. That gives it a new address. Paste the new one into the other app, because the old one stops working. Turning them back on can take a moment while the old secret is removed.'
    : `To stop checking, delete this ${noun} and create it again. The new one gets a new address, so paste that into the other app.`;
  return <>
    <p className="text-sm text-muted-foreground">Paste the signing secret from the other app’s webhook settings. Once it’s saved, we recognize the app and turn away updates whose signature doesn’t match.{legacy ? '' : ' Without a secret, updates aren’t checked.'}</p>
    {legacy && <p className="text-sm text-muted-foreground">This {noun} was set up to always check signatures, so without a saved secret its updates are turned away. {howToStop}</p>}
  </>;
}
