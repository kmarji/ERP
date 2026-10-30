import { ConfigService } from '@nestjs/config';

// One switch for every adapter: INTEGRATION_MODE (default 'stub'), overridable per adapter via <NAME>_MODE.
// Only stub implementations exist until official API access and legal authorization are confirmed (brief s1, s9.2).
export function adapterMode(config: ConfigService, name: string): string {
  return config.get<string>(`${name.toUpperCase()}_MODE`) ?? config.get<string>('INTEGRATION_MODE') ?? 'stub';
}

export function requireStub(config: ConfigService, name: string): void {
  const mode = adapterMode(config, name);
  if (mode !== 'stub') {
    throw new Error(`Adapter ${name} has no '${mode}' implementation yet; set ${name.toUpperCase()}_MODE=stub`);
  }
}
