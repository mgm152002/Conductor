import { useUiStore } from '../../stores';
import { AgentSetupNotice } from './AgentSetupNotice';
import { Mem0OfflineNotice } from './Mem0OfflineNotice';
import { Composer } from './Composer';

// Where Work opens: a header and the composer for a new thread, centred.
// Threads themselves are listed by project in the sidebar.
export function WorkBoard(): React.JSX.Element {
  const planMode = useUiStore((s) => s.planMode);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="window-header flex shrink-0 items-center px-4">
        <h1 className="text-[13px] font-medium text-foreground">New thread</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 pb-[12vh]">
        <div className="mx-auto w-full max-w-(--chat-max)">
          <p className="mb-5 text-center text-xl font-medium text-foreground">What should we build?</p>
          <AgentSetupNotice />
          <Mem0OfflineNotice />
          <Composer task={null} autoFocus variant="hero" />
          {planMode ? <p className="mt-2 text-center text-2xs text-muted-foreground">Plan mode: a planner splits the work across agents.</p> : null}
        </div>
      </div>
    </div>
  );
}
