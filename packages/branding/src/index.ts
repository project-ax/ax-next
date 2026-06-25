export { createBrandingPlugin } from './plugin.js';
export {
  registerBrandingRoutes,
  createBrandingHandlers,
  BRANDING_BODY_MAX_BYTES,
  type BrandingHandlers,
} from './routes.js';
export {
  DEFAULT_RECORD,
  parseRecord,
  serializeRecord,
  toWire,
  type BrandingRecord,
  type WireBranding,
  type LogoPointer,
} from './record.js';
export {
  validateLogoUpload,
  isAllowedContentType,
  ALLOWED_CONTENT_TYPES,
  MAX_LOGO_BYTES,
  type AllowedContentType,
  type ValidateResult,
} from './image-validation.js';
export type { RouteRequest, RouteResponse } from './shared.js';
