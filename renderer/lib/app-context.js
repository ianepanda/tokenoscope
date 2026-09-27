import { createContext, useContext } from './h.js';
import { fmtUsd, fmtTok, fmtTokShort, fmtInt } from './format.js';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function metricFmt(metric) {
  if (metric === 'cost') return { fmt: fmtUsd, axis: fmtUsd };
  if (metric === 'req') return { fmt: fmtInt, axis: fmtInt };
  return { fmt: fmtTok, axis: fmtTokShort };
}
