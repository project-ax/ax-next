import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StepGate } from './step-gate.js';
import { StepAdmin } from './step-admin.js';
import { StepModel } from './step-model.js';
import { StepDone } from './step-done.js';

type Step = 'gate' | 'admin' | 'model' | 'done';

function Wizard() {
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

const root = document.getElementById('root');
if (root === null) throw new Error('root element missing');
createRoot(root).render(<Wizard />);
