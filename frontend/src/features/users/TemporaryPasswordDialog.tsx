import { useEffect, useState } from 'react';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';

export interface TemporaryPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  email: string;
  temporaryPassword: string;
}

const COPIED_RESET_DELAY_MS = 2000;

export function TemporaryPasswordDialog({
  open,
  onClose,
  email,
  temporaryPassword,
}: TemporaryPasswordDialogProps) {
  const [copied, setCopied] = useState(false);

  // Reset the "Copied" confirmation whenever a different password is shown.
  useEffect(() => {
    setCopied(false);
  }, [temporaryPassword]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_RESET_DELAY_MS);
    } catch {
      // Clipboard access can be denied by the browser; the password is
      // still visible on screen to copy by hand.
    }
  }

  return (
    <Dialog
      open={open}
      title="Temporary password"
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="flex flex-col gap-5">
        <p className="font-display text-body font-normal text-text-silver">
          A temporary password was generated for {email}. Share it with them now
          — it will not be shown again.
        </p>

        <div className="flex items-center justify-between gap-4 rounded-small border border-surface-slate bg-surface-kelp px-[14px] py-3">
          <code className="font-ui text-ui tracking-wide text-text-platinum">
            {temporaryPassword}
          </code>
          <Button type="button" variant="ghost" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <p role="alert" className="font-ui text-ui text-text-silver">
          This password will not be shown again. Make sure it is saved or shared
          before closing this dialog.
        </p>
      </div>
    </Dialog>
  );
}
