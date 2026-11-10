import { Composition } from "remotion";
import { BRAIN_MAIN_TOTAL, BrainChatsMain } from "./products/brain/Film";
import { SquareFrame } from "./products/brain/Square";

export const Root: React.FC = () => (
  <>
    <Composition id="Brain-Chats-Main-16x9" component={BrainChatsMain} durationInFrames={BRAIN_MAIN_TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="Square-Frame" component={SquareFrame} durationInFrames={1} fps={30} width={1080} height={1080} />
  </>
);
