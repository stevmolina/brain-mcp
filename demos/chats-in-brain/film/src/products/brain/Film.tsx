import { Film, filmFrames } from "../../kit/film/Film";
import { MAIN } from "./filmCuts";
import { brainFilm } from "./theme";

export const BrainChatsMain: React.FC = () => <Film cut={MAIN} theme={brainFilm} layout="wide" />;
export const BRAIN_MAIN_TOTAL = filmFrames(MAIN);
