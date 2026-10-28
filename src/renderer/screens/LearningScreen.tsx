import { ScreenScaffold } from './ScreenScaffold';
import { LearningPanel } from '../components/workspace/LearningPanel';

export function LearningScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Learning"
      description="Every 5 minutes, the LLM you approve reviews each agent's logs and success rate and works out routing. In manual mode nothing changes until you approve a proposal; in auto mode demonstrated routing is applied for you and rolled back if results get worse."
    >
      <LearningPanel />
    </ScreenScaffold>
  );
}
