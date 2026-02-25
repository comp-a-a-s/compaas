import { useEffect, useRef } from 'react';

// ---- Types ----

export interface WalkthroughProps {
  step: number;       // 0-based current step index
  totalSteps: number;
  title: string;
  body: string;
  onNext: () => void;
  onSkip: () => void;
  onFinish: () => void;
}

// ---- Component ----

export default function Walkthrough({
  step,
  totalSteps,
  title,
  body,
  onNext,
  onSkip,
  onFinish,
}: WalkthroughProps) {
  const isLastStep = step >= totalSteps - 1;
  const skipBtnRef = useRef<HTMLButtonElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);

  // Move focus into the tooltip card whenever the step changes so keyboard
  // users can immediately tab through the action buttons.
  useEffect(() => {
    skipBtnRef.current?.focus();
  }, [step]);

  // Close on Escape key — treat Escape the same as Skip.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSkip();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onSkip]);

  const handlePrimaryAction = () => {
    if (isLastStep) {
      onFinish();
    } else {
      onNext();
    }
  };

  return (
    /* Semi-transparent backdrop — non-interactive so the underlying UI
       remains visible and partially usable. aria-modal marks this as a
       dialog region for assistive technologies. */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Onboarding walkthrough, step ${step + 1} of ${totalSteps}: ${title}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        animation: 'fade-in 0.2s ease-out both',
      }}
    >
      {/* Tooltip card */}
      <article
        style={{
          width: 'min(300px, calc(100vw - 32px))',
          borderRadius: '12px',
          border: '1px solid var(--tf-border)',
          backgroundColor: 'var(--tf-surface)',
          boxShadow: '0 24px 56px rgba(0, 0, 0, 0.45)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          animation: 'slide-up 0.25s ease-out both',
        }}
      >
        {/* Step indicator */}
        <p
          style={{
            margin: 0,
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--tf-text-muted)',
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
          }}
        >
          Step {step + 1} of {totalSteps}
        </p>

        {/* Title */}
        <h2
          style={{
            margin: 0,
            fontSize: '15px',
            fontWeight: 700,
            color: 'var(--tf-text)',
            lineHeight: 1.3,
          }}
        >
          {title}
        </h2>

        {/* Body */}
        <p
          style={{
            margin: 0,
            fontSize: '13px',
            color: 'var(--tf-text-secondary)',
            lineHeight: 1.6,
          }}
        >
          {body}
        </p>

        {/* Progress dots */}
        <nav
          aria-label="Walkthrough progress"
          style={{
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            paddingTop: '2px',
          }}
        >
          {Array.from({ length: totalSteps }, (_, i) => (
            <span
              key={i}
              aria-current={i === step ? 'step' : undefined}
              style={{
                display: 'block',
                width: i === step ? '18px' : '6px',
                height: '6px',
                borderRadius: '3px',
                backgroundColor: i === step
                  ? 'var(--tf-accent)'
                  : 'var(--tf-border)',
                transition: 'width 0.2s ease, background-color 0.2s ease',
                flexShrink: 0,
              }}
            />
          ))}
        </nav>

        {/* Action buttons */}
        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            paddingTop: '4px',
          }}
        >
          {/* Skip — ghost/text style */}
          <button
            ref={skipBtnRef}
            type="button"
            onClick={onSkip}
            style={{
              padding: '7px 12px',
              borderRadius: '8px',
              border: '1px solid transparent',
              backgroundColor: 'transparent',
              color: 'var(--tf-text-muted)',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            Skip
          </button>

          {/* Next / Get Started — accent filled */}
          <button
            ref={nextBtnRef}
            type="button"
            onClick={handlePrimaryAction}
            style={{
              padding: '7px 16px',
              borderRadius: '8px',
              border: '1px solid var(--tf-accent)',
              backgroundColor: 'var(--tf-accent)',
              color: 'var(--tf-bg)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            {isLastStep ? 'Get Started' : 'Next'}
          </button>
        </footer>
      </article>
    </div>
  );
}
