/**
 * @ax/credentials-anthropic-oauth — first per-kind credentials sub-service.
 *
 * Registers three hooks on the bus that the @ax/credentials facade dispatches
 * to when a credential's `kind` is `'anthropic-oauth'`:
 *
 *   credentials:resolve:anthropic-oauth ─ refresh-if-needed (5min buffer)
 *   credentials:login:anthropic-oauth   ─ build PKCE authorize URL + verifier
 *   credentials:exchange:anthropic-oauth ─ swap auth-code for token blob
 *
 * The CLI's `ax-next credentials login anthropic` command stitches the three
 * together: :login → open browser → await callback → :exchange → :set.
 *
 * Web-chat (Phase 10–12) will register HTTP routes that call the same three
 * sub-services — same auth flow, different surface.
 */

import { PluginError, type Plugin } from '@ax/core';
import {
  exchangeAnthropicOauth,
  loginAnthropicOauth,
  type ExchangeInput,
  type ExchangeOutput,
  type LoginInput,
  type LoginOutput,
} from './login.js';
import { resolveAnthropicOauth, type ResolveOutput } from './refresh.js';

const PLUGIN_NAME = '@ax/credentials-anthropic-oauth';

interface ResolveInput {
  payload: Uint8Array;
  userId: string;
  ref: string;
}

export function createCredentialsAnthropicOauthPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:resolve:anthropic-oauth',
        'credentials:login:anthropic-oauth',
        'credentials:exchange:anthropic-oauth',
      ],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<ResolveInput, ResolveOutput>(
        'credentials:resolve:anthropic-oauth',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (!(input.payload instanceof Uint8Array)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'resolve payload must be Uint8Array',
            });
          }
          return resolveAnthropicOauth({ payload: input.payload });
        },
      );

      bus.registerService<LoginInput, LoginOutput>(
        'credentials:login:anthropic-oauth',
        PLUGIN_NAME,
        async (_ctx, input) => loginAnthropicOauth(input),
      );

      bus.registerService<ExchangeInput, ExchangeOutput>(
        'credentials:exchange:anthropic-oauth',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (typeof input.code !== 'string' || input.code === '') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'exchange input.code is required',
            });
          }
          if (typeof input.codeVerifier !== 'string' || input.codeVerifier === '') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'exchange input.codeVerifier is required',
            });
          }
          if (typeof input.state !== 'string' || input.state === '') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'exchange input.state is required',
            });
          }
          return exchangeAnthropicOauth(input);
        },
      );
    },
  };
}
