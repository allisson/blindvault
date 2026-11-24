// What a confirmation shows and what the user's choice does, on the vault's side (extension.md §7.4,
// D268, D288): shared by the extension's session host and the Android provider window (android.md
// §7.5, D301), which differ only in who asks and where the user confirms. Nothing is signed or
// written before the choice, which is the user presence.

import {
  COSE_ALGORITHM,
  createPasskey,
  signPasskeyAssertion,
  signPasskeyAssertionHash,
} from '@blindvault/crypto';
import {
  type ItemView,
  type PasskeyValue,
  type VaultSession,
  passkeyUserName,
} from '@blindvault/vault';

import { hex } from '../app/ids';
import {
  type Checked,
  candidates,
  clientDataJSON,
  holders,
  holdsExcluded,
  saveTargets,
  withPasskey,
} from './passkey';
import { type PasskeyCall, toBase64url } from './passkey-options';
import { type ConfirmChoice, type ConfirmState, type PasskeyResult, type Refusal } from './rpc';

export const NOT_ALLOWED: PasskeyResult = { kind: 'error', name: 'NotAllowedError' };

/** A choice that signs or writes: `browser` and `cancel` end the request without the vault. */
export type VaultChoice = Exclude<ConfirmChoice, { choice: 'browser' | 'cancel' }>;

export interface CarryOutDeps {
  readonly now: () => number;
  /**
   * The `clientDataHash` a privileged browser passed to the Android provider: a get signs over it
   * in place of `SHA-256(clientDataJSON)` (android.md §7.3, D301).
   */
  readonly clientDataHash?: Uint8Array;
}

/** What the confirmation shows of a call, on an unlocked vault (extension.md §7.7 Window). */
export function confirmState(
  s: VaultSession,
  call: PasskeyCall,
  checked: Checked,
): Exclude<ConfirmState, { kind: 'locked' }> {
  const origins = {
    origin: call.origin,
    ...(call.topOrigin === call.origin ? {} : { topOrigin: call.topOrigin }),
    rpId: checked.rpId,
  };
  const items = s.items();
  if (call.kind === 'get') {
    return {
      kind: 'get',
      ...origins,
      passkeys: candidates(items, checked.rpId, call.options.allowCredentials).map(
        ({ credentialId, title, userName }) => ({
          credentialId,
          title,
          ...(userName === undefined ? {} : { userName }),
        }),
      ),
    };
  }
  const { rp, user } = call.options;
  return {
    kind: 'create',
    ...origins,
    rpName: rp.name,
    userName: user.name,
    displayName: user.displayName,
    items: saveTargets(items, call.origin).map((view) => {
      const username = view.item.fields.find((f) => f.role === 'username')?.value;
      return {
        itemId: hex(view.id),
        title: view.item.title,
        ...(typeof username === 'string' && username !== '' ? { username } : {}),
      };
    }),
    replaces: holders(items, checked.rpId, user.id).length > 0,
  };
}

/**
 * Carries out `choice` on the unlocked vault: signs with the chosen passkey, or creates one and
 * saves it. A refusal names a choice the confirmation did not offer.
 */
export async function carryOut(
  s: VaultSession,
  call: PasskeyCall,
  checked: Checked,
  choice: VaultChoice,
  deps: CarryOutDeps,
): Promise<PasskeyResult | Refusal> {
  if ((choice.choice === 'use') !== (call.kind === 'get')) return 'invalid';
  return choice.choice === 'use'
    ? assert(s, call, checked, choice.credentialId, deps)
    : create(s, call, checked, choice, deps);
}

async function assert(
  s: VaultSession,
  call: PasskeyCall,
  checked: Checked,
  credentialId: string,
  deps: CarryOutDeps,
): Promise<PasskeyResult | Refusal> {
  if (call.kind !== 'get') return 'invalid';
  const chosen = candidates(s.items(), checked.rpId, call.options.allowCredentials).find(
    (c) => c.credentialId === credentialId,
  );
  if (!chosen) return 'not-found';
  const data = clientDataJSON(call);
  const signed = deps.clientDataHash
    ? await signPasskeyAssertionHash(chosen.value.privateKey, checked.rpId, deps.clientDataHash)
    : await signPasskeyAssertion(chosen.value.privateKey, checked.rpId, data);
  return {
    kind: 'asserted',
    id: toBase64url(chosen.value.credentialId),
    clientDataJSON: toBase64url(data),
    authenticatorData: toBase64url(signed.authenticatorData),
    signature: toBase64url(signed.signature),
    userHandle: toBase64url(chosen.value.userHandle),
  };
}

async function create(
  s: VaultSession,
  call: PasskeyCall,
  checked: Checked,
  choice: Exclude<VaultChoice, { choice: 'use' }>,
  deps: CarryOutDeps,
): Promise<PasskeyResult | Refusal> {
  if (call.kind !== 'create' || checked.kind !== 'create') return 'invalid';
  const items = s.items();
  const target =
    choice.choice === 'save'
      ? saveTargets(items, call.origin).find((v) => hex(v.id) === choice.itemId)
      : undefined;
  if (choice.choice === 'save' && !target) return 'not-found';
  // Known only after the click, so a page learns from it only what the user allowed (§7.4).
  if (holdsExcluded(items, call.options.excludeCredentials ?? [])) {
    return { kind: 'error', name: 'InvalidStateError' };
  }
  const { user, rp } = call.options;
  const held = holders(items, checked.rpId, user.id);
  // A write that would touch a read-only item is not made at all (overview §6).
  if (!s.writable || held.some((v: ItemView) => v.readOnly !== undefined)) return NOT_ALLOWED;
  const created = await createPasskey(checked.rpId, checked.algorithm);
  try {
    const userName = passkeyUserName(user.name);
    const value: PasskeyValue = {
      privateKey: created.privateKey,
      credentialId: created.credentialId,
      rpId: checked.rpId,
      userHandle: user.id,
      ...(userName === undefined ? {} : { userName }),
      createdAt: deps.now(),
    };
    // Every item holding the replaced passkey, the chosen one included, gets the new one.
    for (const view of held) {
      if (target && hex(view.id) === hex(target.id)) continue;
      await s.updateItem(view.id, withPasskey(view.item, value));
    }
    if (target) {
      await s.updateItem(target.id, withPasskey(target.item, value));
    } else {
      await s.createItem({
        templateId: 'login',
        templateVersion: 1,
        title: rp.name.trim() === '' ? checked.rpId : rp.name.trim(),
        fields: [
          ...(userName === undefined
            ? []
            : [{ type: 'text' as const, role: 'username', value: userName }]),
          { type: 'url', role: 'url', value: `https://${checked.rpId}` },
          { type: 'passkey', value },
        ],
        tags: [],
      });
    }
  } finally {
    created.privateKey.fill(0);
  }
  return {
    kind: 'created',
    id: toBase64url(created.credentialId),
    clientDataJSON: toBase64url(clientDataJSON(call)),
    attestationObject: toBase64url(created.attestationObject),
    authenticatorData: toBase64url(created.authenticatorData),
    publicKey: toBase64url(created.publicKey),
    publicKeyAlgorithm: COSE_ALGORITHM[checked.algorithm],
  };
}
