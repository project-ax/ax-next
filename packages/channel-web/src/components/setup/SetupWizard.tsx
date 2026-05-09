import { useEffect, useState } from 'react';
import { StepGate } from './StepGate';
import { StepAdmin } from './StepAdmin';
import { StepModel } from './StepModel';
import { StepDone } from './StepDone';

type Step = 'gate' | 'admin' | 'model' | 'done';

export function SetupWizard() {
  const [step, setStep] = useState<Step>('gate');
  const [autoToken, setAutoToken] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get('token');
    if (t !== null) {
      setAutoToken(t);
      // Strip the token from the URL bar without a navigation, so a
      // refresh doesn't re-leak it via browser history.
      history.replaceState({}, '', location.pathname);
    }
  }, []);

  if (step === 'gate') return <StepGate autoToken={autoToken} onClaimed={() => setStep('admin')} />;
  if (step === 'admin') return <StepAdmin onCreated={() => setStep('model')} />;
  if (step === 'model') return <StepModel onComplete={() => setStep('done')} />;
  return <StepDone />;
}
