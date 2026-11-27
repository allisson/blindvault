import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';

import { formAlert } from './alerts';
import { createVault } from './create';
import { storedPlaintext } from './stored';

// Calibrating Argon2id targets about 1 s per derivation (D9), on every browser.
test.setTimeout(120_000);

const PASSWORD = 'quartz-lantern-velvet-harbor-9214';
const CONTENT = 'Lease of flat 7731, signed by both parties';

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function attach(page: Page, name: string, content: string | Buffer, mimeType = 'application/pdf') {
  return page.getByTestId('attachment-input').setInputFiles({
    name,
    mimeType,
    buffer: typeof content === 'string' ? Buffer.from(content) : content,
  });
}

async function newNote(page: Page, title: string) {
  await page.goto('/');
  await createVault(page, PASSWORD);
  await button(page, 'New item').click();
  await button(page, 'Secure note').click();
  await page.getByTestId('item-title').fill(title);
}

test('adds an attachment, stores it encrypted, and downloads it from the item and its history (attachments.md §7)', async ({
  page,
}) => {
  await newNote(page, 'Lease');
  await attach(page, 'lease:v1.pdf', CONTENT);
  // Shown by name and size, read only when saved.
  await expect(page.getByTestId('attachment-file')).toHaveText(
    `lease:v1.pdf · ${String(CONTENT.length)} byte`,
  );
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Lease', level: 1 })).toBeVisible();
  // Without a label, the name is the field's label and shows once (D312).
  await expect(page.getByTestId('attachment-file')).toHaveText(
    `${String(CONTENT.length)} byte · application/pdf`,
  );

  // Nothing of the file is stored in the clear (CRYPTO-INV-001).
  const stored = await storedPlaintext(page, [CONTENT, 'lease:v1.pdf']);
  expect(stored.chunks).toBeGreaterThan(0);
  expect(stored.found).toEqual([]);

  // Saved as an octet-stream under the sanitized name, never opened in the app.
  const saved = page.waitForEvent('download');
  await button(page, 'Download: lease:v1.pdf').click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe('lease_v1.pdf');
  expect(await readFile(await download.path(), 'utf8')).toBe(CONTENT);
  expect(page.url()).not.toContain('blob:');

  // The label is edited, the file stays; the earlier version downloads too.
  await button(page, 'Edit').click();
  await page.getByTestId('custom-label').fill('Signed lease');
  await button(page, 'Save').click();
  await expect(button(page, 'Download: Signed lease')).toBeVisible();
  // With a label, the name joins the size and the type.
  await expect(page.getByTestId('attachment-file')).toHaveText(
    `lease:v1.pdf · ${String(CONTENT.length)} byte · application/pdf`,
  );
  await button(page, 'History').click();
  await expect(page.getByRole('heading', { name: 'History of Lease' })).toBeVisible();
  const fromHistory = page.waitForEvent('download');
  await button(page, 'Download: lease:v1.pdf').click();
  expect(await readFile(await (await fromHistory).path(), 'utf8')).toBe(CONTENT);
});

test('refuses an empty file and one above 10 MiB when picked, and removes an attachment (attachments.md §7)', async ({
  page,
}) => {
  await newNote(page, 'Scans');
  await attach(page, 'empty.txt', '', 'text/plain');
  await expect(formAlert(page)).toHaveText(
    'This file is empty, and an empty file cannot be attached.',
  );
  await attach(page, 'big.bin', Buffer.alloc(10 * 1024 * 1024 + 1, 1), 'application/octet-stream');
  await expect(formAlert(page)).toHaveText(
    'This file is larger than 10 MiB, the most an attachment can hold.',
  );
  await expect(page.getByTestId('attachment-file')).toHaveCount(0);

  // Taken, then removed before saving: nothing is attached.
  await attach(page, 'scan.png', 'png bytes', 'image/png');
  await expect(formAlert(page)).toHaveCount(0);
  await expect(page.getByTestId('attachment-file')).toHaveCount(1);
  await button(page, 'Remove').click();
  await expect(page.getByTestId('attachment-file')).toHaveCount(0);
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Scans', level: 1 })).toBeVisible();
  await expect(page.getByTestId('attachment-file')).toHaveCount(0);
});
