import { permanentRedirect } from 'next/navigation';

// Legacy path. Canonical submit form lives at /dashboard/models/new.
// The richer 4-step compliance variant that previously lived here is
// preserved in git history (commit before this redirect lands) and can be
// resurrected at the canonical path in a follow-up.
export default function MeSubmitModelLegacy(): never {
  permanentRedirect('/dashboard/models/new');
}
