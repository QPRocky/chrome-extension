# Local Dev Extension

Chrome-extension (MV3), joka lisää DevToolsiin **DevKit**-paneelin:

- **Network**: tallentaa pyynnöt vastausbodyineen heti kun DevTools avataan. Suodatus (URL-teksti, `-poissulku`, `/regex/`, metodi, tyyppi, status), haku response-bodyista samalla syntaksilla (piilottaa pyynnöt, joiden vastauksesta ei löydy osumaa), yksityiskohdat, *Copy as cURL / fetch*, vienti **HAR**- (voi raahata Chromen Network-välilehteen) tai yksinkertaistettuna **JSON**-tiedostona.
  - **Full capture** (toolbarin valinta): tallentaa `chrome.debugger`in kautta `chrome.devtools.network`in sijaan. Chrome jättää extensioneilta pois pyynnöt, joiden initiator-stackissa, redirectissä tai `Location`/`Link`-headerissa on URL, johon extensionilla ei ole pääsyä – esimerkiksi toisen extensionin skripti. Jos Redux DevTools (tai muu sivulle injektoiva extension) on asennettu, tämä koskee käytännössä kaikkia thunkeista lähteviä fetch/XHR-pyyntöjä, jolloin Fetch/XHR-lista jää tyhjäksi. Full capture näkee ne. Kun se on päällä, Chrome näyttää "debugging this browser" -palkin; palkin *Cancel* kytkee Full capturen pois. WebSocketit ja erillisprosessissa ajettavat iframet eivät näy Full capturessa.
- **Redux**: action-loki (suodatus tyypin ja payloadin sisällön mukaan, välilyönnillä erotetut termit), tilapuu ja haku, diff, **jump / time travel**, oma dispatch, tilan vienti ja tuonti JSON-tiedostona.
- **Forms**: lomakkeen arvot voi tallentaa nimettynä tallenteena ja täyttää lomakkeen niillä uudelleen. Samalle lomakkeelle saa olla useita tallenteita eri use-caseihin. Kenttiä voi jättää täytöstä pois, arvoja muokata ja vertailla tallennettua arvoa lomakkeen nykyiseen. Ks. [Forms](#forms).

## Käyttö

```sh
npm install
npm run build        # → dist/
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → valitse `dist/`
2. Avaa sivu, avaa DevTools ja valitse **DevKit**-välilehti.
3. Jos sivu oli auki jo ennen asennusta, lataa se uudelleen.

Kehitys: `npm run dev` rakentaa uudelleen muutoksista (lataa extension uudelleen `chrome://extensions`-sivulta), `npm test`, `npm run typecheck`.

Testisovellus: `npm run playground` → http://localhost:5174 (React + RTK + redux-form + mock-API). `?devtools=0` luo storen ilman DevTools-tukea, jolloin näkyy rajoitettu tila.

## Forms

| Tapa | Milloin | Miten täyttö tehdään |
| --- | --- | --- |
| **redux-form** | Sovellus käyttää `redux-form`ia (reducer löytyy `state.form`ista tai mistä tahansa ylätason avaimesta, jos `getFormState` on konfiguroitu) | Dispatchaa `@@redux-form/CHANGE`-actionit storeen, joten middlewaret ja sagat näkevät muutokset kuin käyttäjän tekeminä. Toimii myös komponenteille, joita ei voi täyttää DOMin kautta (suomifi SingleSelect, react-select, DateInput), sekä ehdollisesti renderöityville kentille: redux-form säilyttää arvon, ja kenttä poimii sen mountatessaan. Vaatii, että store on löytynyt (ks. taulukko alla). |
| **DOM** | Muut React-lomakkeet (`useState`, react-hook-form) | Kirjoittaa natiiveihin `input`/`select`/`textarea`-kenttiin natiivisettereillä ja lähettää `input`- ja `change`-eventit, joita React kuuntelee. Täyttö tehdään enintään kolmessa passissa, jotta vasta täytön jälkeen renderöityvät kentät ehtivät ilmestyä. Kustomikomponentit eivät täyty tätä kautta. |

Kenttien nimet tulevat redux-formin `registeredFields`istä; FieldArray tallennetaan kokonaisena taulukkona. DOM-lomakkeissa kentän avain on `name`, `id`, `aria-label`, labelin teksti tai `placeholder` — tässä järjestyksessä. `password`- ja `file`-kenttiä ei tallenneta.

Tallenteet ovat **origin-kohtaisia**: localhostilla tehty tallenne ei näy testiympäristössä. Siirto ympäristöjen välillä tehdään *Export*- ja *Import*-napeilla; import leimaa tallenteet nykyiselle originille. Tallenteet ovat `chrome.storage.local`issa, ja kaksi avointa DevTools-ikkunaa pysyy synkassa.

Täytön jälkeen paneeli lukee lomakkeen uudelleen ja kertoo, jos sovellus muutti kenttiä (tyypillisesti riippuva select tyhjenee, kun parent vaihtuu) — *Fill again* täyttää ne uudelleen. *Touch fields* -valinta merkitsee täytetyt kentät kosketetuiksi, jolloin validointiviestit tulevat näkyviin.

## Miten Redux-store löytyy

| Tila | Milloin | Ominaisuudet |
| --- | --- | --- |
| **hooked** | Store luodaan Redux DevTools -tuella: RTK `configureStore` (devTools on oletuksena päällä), `composeWithDevTools` tai `window.__REDUX_DEVTOOLS_EXTENSION__()` | Kaikki |
| **limited** | Store löytyy react-reduxin `<Provider store>` -propista ("Scan React tree", ajetaan automaattisesti jos hookattua storea ei ole). Toimii myös tuotantobuildeissa. | Loki, tila, diff, dispatch. Ei jumpia eikä importia, koska reduceriin ei päästä käsiksi. Thunkien sisäiset ja ennen patchausta talteen otetut dispatchit näkyvät nimellä `(state changed)`. |

Hook toimii rinnakkain virallisen Redux DevToolsin kanssa.

## Rakenne

```
src/content/redux-hook.ts   MAIN world: enhancer-shim + fiber-haku + historia (src/content/redux/*)
src/content/bridge.ts       ISOLATED world: window.postMessage ↔ chrome.runtime
src/background/index.ts     välittää viestit paneelin ja tabin välillä
src/devtools/devtools.ts    luo paneelin ja tallentaa network-pyynnöt (NetworkStore)
src/content/forms/          lomakkeiden tunnistus ja täyttö (redux-form + DOM)
src/panel/                  UI: network/, redux/, forms/, ui/
```

Sivulta lähtevät Redux-tapahtumat välitetään eteenpäin vain, kun paneeli on auki, joten muut välilehdet eivät herätä service workeria.
