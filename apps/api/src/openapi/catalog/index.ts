import { STATUS } from './status';
import { AUTH } from './auth';
import { PRODUCTS } from './products';
import { ITINERARY } from './itinerary';
import { MATCHING } from './matching';
import { PLANNING } from './planning';
import { AUDIT } from './audit';
import { PATCHES } from './patches';
import { REPORT } from './report';
import { RADAR } from './radar';
import { STANDARDS } from './standards';
import { REFERENCE } from './reference';
import type { Endpoint } from '../types';

/**
 * 문서에 싣는 순서 그대로 잇는다 — 태그 순서(`tags.ts`)와 같다. 묶음 안의 순서는 각 파일의 순서다.
 */
export const CATALOG: readonly Endpoint[] = [
  ...STATUS,
  ...AUTH,
  ...PRODUCTS,
  ...ITINERARY,
  ...MATCHING,
  ...PLANNING,
  ...AUDIT,
  ...PATCHES,
  ...REPORT,
  ...RADAR,
  ...STANDARDS,
  ...REFERENCE,
];
