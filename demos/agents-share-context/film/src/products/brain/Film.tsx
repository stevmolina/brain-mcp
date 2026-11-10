import { Film, filmFrames } from "../../kit/film/Film";
import { HOWTO, HOWTO_ES, MAIN, MAIN_ES, T_ES } from "./filmCuts";
import { FilmLang, PANELS } from "./panels";
import { brainFilm, brainFilmEs } from "./theme";

export const AgentsMain: React.FC = () => <Film cut={MAIN} theme={brainFilm} layout="wide" panels={PANELS} />;
export const AgentsHowTo: React.FC = () => <Film cut={HOWTO} theme={brainFilm} layout="wide" panels={PANELS} />;
export const AgentsMainEs: React.FC = () => <FilmLang.Provider value={{ lang: "es", T: T_ES }}><Film cut={MAIN_ES} theme={brainFilmEs} layout="wide" panels={PANELS} /></FilmLang.Provider>;
export const AgentsHowToEs: React.FC = () => <FilmLang.Provider value={{ lang: "es", T: T_ES }}><Film cut={HOWTO_ES} theme={brainFilmEs} layout="wide" panels={PANELS} /></FilmLang.Provider>;
export const MAIN_TOTAL = filmFrames(MAIN);
export const HOWTO_TOTAL = filmFrames(HOWTO);
export const MAIN_ES_TOTAL = filmFrames(MAIN_ES);
export const HOWTO_ES_TOTAL = filmFrames(HOWTO_ES);
