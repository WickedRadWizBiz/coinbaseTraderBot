// Base feature set (the original v2 inputs). The full candidate registry,
// including features ported from the old model, lives in featureEngine.ts.
import { featuresInGroups } from './featureEngine';

export const FEATURE_NAMES = featuresInGroups(['base']);
