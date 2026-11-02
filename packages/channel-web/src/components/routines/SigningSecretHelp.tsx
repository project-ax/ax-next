/**
 * What a saved signing secret does, shown next to the Signing secret row on the task page and in
 * Settings (TASK-1026). A routine with a legacy signature setting (`webhook.hmac`) always checks, so
 * its help never says updates go unchecked, and it says how to stop: removing app updates clears the
 * setting and the saved secret, and adding them back issues a new address once the old secret is gone.
 */
export function SigningSecretHelp({ legacy, noun }: { legacy: boolean; noun: 'task' | 'routine' }) {
  return <>
    <p className="text-sm text-muted-foreground">Paste the signing secret from the other app’s webhook settings. Once it’s saved, we recognize the app and turn away updates whose signature doesn’t match.{legacy ? '' : ' Without a secret, updates aren’t checked.'}</p>
    {legacy && <p className="text-sm text-muted-foreground">This {noun} was set up to always check signatures, so without a saved secret its updates are turned away. To stop checking, turn off its app updates and save, then turn them back on. That gives it a new address. Turning them back on can take a moment while the old secret is removed.</p>}
  </>;
}
