import { type Item } from '@blindvault/vault';
import { useId } from 'react';

import { avatar, rowPassword, subtitle } from '../app/row';
import { useMessages } from '../i18n/context';
import { type Messages } from '../i18n/messages';
import { Button, TARGET } from './components';
import { Icon, type IconName } from './icons';

// The list row (D246): an avatar, the title, a subtitle of non-secret fields and Copy for a
// password. Nothing secret is rendered (CRYPTO-INV-024): Copy holds the password in its handler.

/** The six avatar pairs, as literal classes so Tailwind generates them. */
const AVATAR = [
  'bg-avatar-1 text-avatar-1-ink',
  'bg-avatar-2 text-avatar-2-ink',
  'bg-avatar-3 text-avatar-3-ink',
  'bg-avatar-4 text-avatar-4-ink',
  'bg-avatar-5 text-avatar-5-ink',
  'bg-avatar-6 text-avatar-6-ink',
] as const;

export const TEMPLATE_ICON: Record<keyof Messages['templates'], IconName> = {
  login: 'key-round',
  'secure-note': 'sticky-note',
  card: 'credit-card',
  identity: 'id-card',
  'developer-credential': 'code-xml',
  'crypto-wallet': 'wallet',
  document: 'file-text',
};

export type Template = keyof Messages['templates'];

export const known = (id: string): id is Template => Object.hasOwn(TEMPLATE_ICON, id);

/** A title's initial on its color pair, with the template's icon in a corner. Decorative. */
export function Avatar({
  title,
  templateId,
  large = false,
}: {
  readonly title: string;
  readonly templateId?: string | undefined;
  readonly large?: boolean;
}) {
  const { initial, color } = avatar(title);
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center rounded-card font-semibold ${large ? 'size-14 text-2xl' : 'size-9'} ${AVATAR[color] ?? AVATAR[0]}`}
    >
      {initial}
      {templateId !== undefined && known(templateId) ? (
        <span className="absolute -end-1 -bottom-1 grid size-4.5 place-items-center rounded-control bg-raised text-muted ring-1 ring-line">
          <Icon name={TEMPLATE_ICON[templateId]} className="size-3!" />
        </span>
      ) : null}
    </span>
  );
}

/** One item of the list. `item` is absent for an item from a newer app version. */
export function ItemRow({
  name,
  item,
  selected,
  onSelect,
  onCopy,
}: {
  readonly name: string;
  readonly item?: Item | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onCopy: (password: string) => void;
}) {
  const m = useMessages();
  const id = useId();
  const template = item !== undefined && known(item.templateId) ? item.templateId : undefined;
  const sub = item ? subtitle(item) || (template ? m.templates[template] : '') : '';
  const password = item ? rowPassword(item) : undefined;
  return (
    <div className="flex items-center gap-1 rounded-control pe-1 hover:bg-subtle has-aria-[current]:bg-accent-soft">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        data-row
        aria-describedby={sub ? id : undefined}
        className={`${TARGET} flex min-w-0 flex-1 items-center gap-3 rounded-control px-2 py-2 text-left text-sm`}
        onClick={onSelect}
      >
        <Avatar title={name} templateId={item?.templateId} />
        <span className="flex min-w-0 flex-col">
          <span data-testid="row-title" className="truncate font-medium">
            {name}
          </span>
          {sub ? (
            // Out of the name, which stays the title; read as the description instead.
            <span id={id} aria-hidden="true" className="truncate text-xs text-muted">
              {sub}
            </span>
          ) : null}
        </span>
      </button>
      {password !== undefined ? (
        <Button
          variant="quiet"
          aria-label={`${m.vault.copyPassword}: ${name}`}
          title={m.vault.copyPassword}
          onClick={() => {
            onCopy(password);
          }}
        >
          <Icon name="copy" className="me-2" />
          {m.items.copy}
        </Button>
      ) : null}
    </div>
  );
}
