import { Composition } from "remotion";
import { AgentsHowTo, AgentsMain, HOWTO_TOTAL, MAIN_TOTAL } from "./products/brain/Film";
import { SquareFrame } from "./products/brain/Square";

export const Root: React.FC = () => (
  <>
    <Composition id="Brain-Agents-Main-16x9" component={AgentsMain} durationInFrames={MAIN_TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="Brain-Agents-HowTo-16x9" component={AgentsHowTo} durationInFrames={HOWTO_TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="Square-Frame" component={SquareFrame} defaultProps={{ link: "brain.mcpbox.dev" }} durationInFrames={1} fps={30} width={1080} height={1080} />
  </>
);
