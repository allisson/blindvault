// Factory templates as versioned code definitions (record-content.md §5, D20, D165).

export const FIELD_TYPES = [
  'text',
  'long-text',
  'secret',
  'url',
  'email',
  'phone',
  'date',
  'number',
  'totp',
  'seed-phrase',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface RoleDefinition {
  readonly role: string;
  readonly type: FieldType;
  /** A `date` role that accepts only `YYYY-MM` (D170). */
  readonly monthPrecision?: true;
}

export interface Template {
  readonly id: string;
  readonly version: number;
  /** In the order a new item shows them. */
  readonly roles: readonly RoleDefinition[];
}

const role = (name: string, type: FieldType): RoleDefinition => ({ role: name, type });

export const TEMPLATES: readonly Template[] = [
  {
    id: 'login',
    version: 1,
    roles: [role('username', 'text'), role('password', 'secret'), role('url', 'url')],
  },
  { id: 'secure-note', version: 1, roles: [] },
  {
    id: 'card',
    version: 1,
    roles: [
      role('cardholder', 'text'),
      role('number', 'secret'),
      { role: 'expiry', type: 'date', monthPrecision: true },
      role('cvv', 'secret'),
      role('pin', 'secret'),
    ],
  },
  {
    id: 'identity',
    version: 1,
    roles: [
      role('firstName', 'text'),
      role('lastName', 'text'),
      role('birthDate', 'date'),
      role('email', 'email'),
      role('phone', 'phone'),
      role('address', 'long-text'),
    ],
  },
  {
    id: 'developer-credential',
    version: 1,
    roles: [
      role('provider', 'text'),
      role('baseUrl', 'url'),
      role('keyId', 'text'),
      role('secret', 'secret'),
    ],
  },
  {
    id: 'crypto-wallet',
    version: 1,
    roles: [
      role('walletName', 'text'),
      role('network', 'text'),
      role('seedPhrase', 'seed-phrase'),
      role('passphrase', 'secret'),
      role('derivationPath', 'text'),
      role('address', 'text'),
    ],
  },
  {
    id: 'document',
    version: 1,
    roles: [
      role('documentType', 'text'),
      role('number', 'text'),
      role('fullName', 'text'),
      role('issuer', 'text'),
      role('issueDate', 'date'),
      role('expiryDate', 'date'),
    ],
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** The template of `id` as this app knows it, at its current version. */
export function template(id: string): Template | undefined {
  return BY_ID.get(id);
}

export function roleOf(t: Template, name: string): RoleDefinition | undefined {
  return t.roles.find((r) => r.role === name);
}
