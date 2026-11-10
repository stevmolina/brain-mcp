import { Film, filmFrames } from "../../kit/film/Film";
import { HOWTO, MAIN } from "./filmCuts";
import { PANELS } from "./panels";
import { brainFilm } from "./theme";

export const AgentsMain: React.FC = () => <Film cut={MAIN} theme={brainFilm} layout="wide" panels={PANELS} />;
export const AgentsHowTo: React.FC = () => <Film cut={HOWTO} theme={brainFilm} layout="wide" panels={PANELS} />;
export const MAIN_TOTAL = filmFrames(MAIN);
export const HOWTO_TOTAL = filmFrames(HOWTO);
