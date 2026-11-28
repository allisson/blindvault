# Phase 11 prototype

The UX prototype Phase 11 implements (D316), frozen from the Design artifact "BlindVault — nova UX":
the 57 original artboards from version `1795865325-5b25`, and the 39 screens the prototype lacked,
drawn on its "Telas novas" page and approved by the owner batch by batch, from version
`1795870454-2772`. The PNGs are the reference; where a PNG and the overview disagree, the
overview wins (D316's "Kept against the prototype").

- `sources/`: the artifact's `.dc.html` artboards and `canvas.json` (positions, titles, pages and
  the canvas notes), byte for byte as published. Prettier skips this folder.
- `light/` and `dark/`: one PNG per artboard and theme, at the artboard's size and a scale of 1,
  with the teal accent, the prototype's default.

The PNGs were rendered in Chromium (Playwright 1.63.0): each artboard's `{{rootClass}}` replaced
by `bv acc-teal`, or `bv acc-teal dark` for the dark theme, its two scripts removed, and the
`.bv` element captured once its fonts loaded. The fonts came from Google Fonts at render time
only; the app self-hosts them (section 13.7).

Known flaw kept in the reference: in `Parear-2`, the response card's Read with the camera and
Paste buttons overflow the card on the computer side.

## Artboards by task

Every artboard is in `light/`, `dark/` and `sources/` under the same name.

### Start, unlock and create

| Artboard | Title | Size |
| --- | --- | --- |
| `Main` | Boas-vindas | 1280 × 800 |
| `Desbloquear` | Desbloquear (celular) | 390 × 844 |
| `Desbloquear-erro` | Senha errada | 390 × 844 |
| `Esqueci` | Esqueci a senha | 390 × 844 |
| `Criar-1` | Criar 1/3: Frase de Recuperação | 390 × 844 |
| `Criar-2` | Criar 2/3: confirmar palavras | 390 × 844 |
| `Criar-3` | Criar 3/3: senha local | 390 × 844 |
| `Criar-pronto` | Cofre pronto: próximos passos | 390 × 844 |
| `Restaurar` | Restaurar de um backup | 390 × 844 |

### Shell, vault and items

The shell (sidebar, status card, bottom bar, status line) is drawn in `Cofre` and `Cofre-celular`.

| Artboard | Title | Size |
| --- | --- | --- |
| `Cofre` | Cofre (computador) | 1280 × 800 |
| `Cofre-celular` | Cofre (celular) | 390 × 844 |
| `Item-celular` | Item (celular) | 390 × 844 |
| `Busca-vazia` | Busca sem resultado | 390 × 844 |
| `Novo-item` | Novo item: escolher modelo | 1280 × 800 |
| `Editor` | Editor com gerador de senha | 1280 × 800 |
| `Historico` | Histórico do item | 1280 × 800 |
| `Passkey-item` | Item com passkey | 1280 × 800 |
| `Remover-passkey` | Remover passkey | 1280 × 800 |
| `Descartar` | Descartar alterações | 1280 × 800 |

### Devices

| Artboard | Title | Size |
| --- | --- | --- |
| `Aparelhos` | Aparelhos (computador) | 1280 × 800 |
| `Aparelhos-celular` | Aparelhos: só um aparelho (celular, escuro) | 390 × 844 |
| `Parear-1` | Parear 1/4: preparar os dois | 1440 × 900 |
| `Parear-2` | Parear 2/4: trocar os códigos | 1440 × 900 |
| `Parear-3` | Parear 3/4: conferir o número | 1440 × 900 |
| `Parear-4` | Parear 4/4: pronto | 1440 × 900 |
| `Sincronizar` | Sincronizar: quem mostra o código | 390 × 844 |
| `Sincronizar-2` | Sincronizar: trocar códigos | 390 × 844 |
| `Sincronizar-3` | Sincronizar: ao vivo, com aviso | 390 × 844 |
| `Reconectar` | Reconectar um aparelho restaurado | 1280 × 800 |
| `Aposentar` | Aposentar um aparelho | 1280 × 800 |
| `Erro-numeros` | Números diferentes | 390 × 844 |
| `Erro-tempo` | Expirou ou app oculto | 390 × 844 |
| `Erro-camera` | Câmera negada: colar texto | 390 × 844 |
| `Erro-cofre` | O outro já tem um cofre | 390 × 844 |

### Settings

| Artboard | Title | Size |
| --- | --- | --- |
| `Configuracoes` | Configurações | 1280 × 800 |
| `Configuracoes-celular` | Configurações (celular) | 390 × 844 |
| `Aparencia` | Aparência | 1280 × 800 |
| `Idioma` | Idioma | 1280 × 800 |
| `Bloqueio` | Bloqueio | 1280 × 800 |
| `Senha-local` | Senha local | 1280 × 800 |
| `Passkey-desbloqueio` | Passkey de desbloqueio | 1280 × 800 |
| `Recuperacao` | Frase de Recuperação | 1280 × 800 |
| `Backup` | Backup | 1280 × 800 |
| `Importar` | Importar | 1280 × 800 |
| `Este-aparelho` | Este aparelho | 1280 × 800 |
| `Zona-de-risco` | Refundar e apagar | 1280 × 800 |
| `Sobre` | Sobre o BlindVault | 1280 × 800 |

### Extension

| Artboard | Title | Size |
| --- | --- | --- |
| `Ext-popup` | Popup sobre a página de login | 1280 × 800 |
| `Popup-bloqueado` | Popup: cofre bloqueado | 380 × 580 |
| `Popup-sem-login` | Popup: nenhum login da página, copiado | 380 × 580 |
| `Passkey-entrar` | Passkey: entrar | 420 × 640 |
| `Passkey-salvar` | Passkey: salvar, substituindo | 420 × 640 |
| `Passkey-bloqueado` | Passkey: cofre bloqueado | 420 × 640 |
| `Ext-boas-vindas` | Boas-vindas na extensão | 1280 × 800 |
| `Ext-versao` | A extensão mudou | 1280 × 800 |
| `Ext-passkeys` | Configurações › Passkeys | 1280 × 800 |
| `Ext-parear` | Parear a extensão no mesmo computador | 1440 × 900 |

### Android

The prototype draws no Android screen: the Android task takes the phone artboards above, and the
biometric unlock, provider window and About are drawn by the task for the missing screens.

## Screens drawn in Phase 11

Drawn in the prototype's visual language for the screens it lacked (Phase 11's third task), with
the app's copy and "dispositivo" read as "aparelho" (D316). They keep what D316 keeps against the
prototype: text on every security action, the copy toast saying clearing is not guaranteed, no
device name while locked, import's format and plaintext warning, and no dismiss on the storage
warning. A few strings are new and enter the catalogs with the copy task: the trash's intro and
purge date per row, the status card's and Avisos' lines, "Agora não" on the update, "Até 10 MiB
por arquivo.", the retired list's dates, "Menu", "Mais", "ou" between biometrics and password, and
the bound state of the provider's link check.

| Artboard | Title | Size | Task |
| --- | --- | --- | --- |
| `Lixeira` | Lixeira | 1280 × 800 | Vault and items |
| `Pasta` | Pasta: ações | 1280 × 800 | Vault and items |
| `Primeiros-passos` | Primeiros passos | 1280 × 800 | Vault and items |
| `Mesclar` | Mesclar 3/4 | 1280 × 800 | Settings |
| `Mesclar-pronto` | Mesclar: pronto, com avisos | 1280 × 800 | Settings |
| `Regenerar` | Regenerar 1/5: aviso | 1280 × 800 | Settings |
| `Refundar` | Refundar 1/5: avisos | 1280 × 800 | Settings |
| `Apagar` | Apagar este cofre deste aparelho | 1280 × 800 | Settings |
| `Importar-formato` | Importar 1/4: formato | 1280 × 800 | Settings |
| `Importar-previa` | Importar 3/4: prévia | 1280 × 800 | Settings |
| `Restaurar-2` | Restaurar 2/3: abrir o backup | 390 × 844 | Start, unlock and create |
| `Restaurar-3` | Restaurar 3/3: senha local | 390 × 844 | Start, unlock and create |
| `Substituir` | Substituir a partir do desbloqueio | 390 × 844 | Start, unlock and create |
| `Instalar` | Instalar primeiro (Safari) | 390 × 844 | Start, unlock and create |
| `Atualizar` | Atualizar | 1280 × 800 | Shell |
| `Outra-janela` | Aberto em outra janela | 1280 × 800 | Start, unlock and create |
| `Erro` | Algo deu errado | 1280 × 800 | Shell |
| `Service-worker` | Service worker alterado | 1280 × 800 | Shell |
| `Moldura` | Dentro de outra página | 1280 × 800 | Start, unlock and create |
| `Avisos` | Avisos do cofre | 1280 × 800 | Shell |
| `Avisos-celular` | Avisos no celular | 390 × 844 | Shell |
| `Aposentados` | Aparelhos aposentados | 1280 × 800 | Devices |
| `STUN` | Servidores STUN | 1280 × 800 | Devices |
| `Gerador-palavras` | Gerador em palavras | 1280 × 800 | Vault and items |
| `Editor-totp-anexos` | Editor: TOTP e anexos | 1280 × 800 | Vault and items |
| `Item-anexos` | Item com anexos | 1280 × 800 | Vault and items |
| `Historico-restaurar` | Histórico: restaurar uma versão | 1280 × 800 | Vault and items |
| `Toast-celular` | Toast de cópia (celular) | 390 × 844 | Vault and items |
| `Toast-computador` | Toast de cópia (computador) | 1280 × 800 | Vault and items |
| `Sheet-acoes` | Bottom sheet: mais ações | 390 × 844 | Vault and items |
| `Sheet-filtro` | Bottom sheet: filtrar por tipo | 390 × 844 | Vault and items |
| `Tablet` | Tablet em 800 px | 800 × 1100 | Shell |
| `Tablet-gaveta` | Tablet: gaveta aberta | 800 × 1100 | Shell |
| `Android-biometria` | Android: desbloqueio por biometria | 390 × 844 | Android |
| `Android-provedor` | Android: janela do provedor | 390 × 844 | Android |
| `Android-sobre` | Android: Sobre | 390 × 844 | Android |
| `Passkey-frame` | Passkey: pedido de dentro de um frame | 420 × 640 | Extension |
| `Passkey-encerrado` | Passkey: pedido encerrado | 420 × 640 | Extension |
| `Passkey-sem` | Passkey: nenhuma do site | 420 × 640 | Extension |
