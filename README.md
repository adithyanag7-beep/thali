# Thali

A calorie and macro log for Indian home cooking, made to be added to an iPhone Home Screen. Each person installs their own copy; all data stays on their phone.

## Put it online (GitHub Pages)

1. Upload every file and folder in this folder to the top level of a public GitHub repository (`index.html` must not be inside a sub-folder).
2. In the repository: **Settings › Pages**, Source **Deploy from a branch**, Branch **main**, folder **/ (root)**, **Save**.
3. After a minute or two the site is live at `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.

## Install on an iPhone

1. Open the site in Safari, tap **Share** (on newer iPhones tap **•••** first), then **Add to Home Screen**, then **Add**.
2. Open Thali from the Home Screen icon and always use that icon. Food logged in Safari stays in Safari.
3. In **Settings**, paste a Claude API key from [platform.claude.com](https://platform.claude.com), tap **Save key**, then **Test key**.

Deleting the Home Screen icon deletes that phone's log. Use **Settings › Save a backup** now and then.

## Updating

Whenever you change a file, increase `VERSION` in `sw.js` (for example `1.0.0` → `1.0.1`) and upload the changed files. Phones then show **Update now**.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The page |
| `css/app.css` | Look and layout (light and dark) |
| `js/config.js` | Model IDs, prices for the cost estimate, photo size, default goal |
| `js/app.js` | Screens and buttons |
| `js/ai.js` | Claude API calls, prompts, JSON checking |
| `js/off.js` | Open Food Facts lookups and remembered barcodes |
| `js/scanner.js` | Live and photo barcode reading |
| `js/store.js` | On-phone storage, usage counter, backup and restore |
| `js/nutrition.js`, `js/image.js`, `js/icons.js` | Helpers |
| `sw.js` | Offline support |
| `vendor/` | Barcode decoder (barcode-detector 3.2.2 and zxing-wasm 3.1.3, MIT) |
| `fonts/` | Lexend (SIL Open Font License) |

The API key is never in the code. It is pasted into Settings on each phone and stored only there.
