import { ScreenScaffold } from './ScreenScaffold';
import { TaskList } from '../components/workspace/TaskList';
import { AuditTrail } from '../components/workspace/AuditTrail';
import { LearningPanel } from '../components/workspace/LearningPanel';

export function RecentActivityScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Recent activity"
      description="Review task history and inspect the recorded progress, outputs, approvals, and verification evidence."
    >
      <div className="flex flex-col gap-8">
        <TaskList history />
        <LearningPanel />
        <AuditTrail />
      </div>
    </ScreenScaffold>
  );
}
