// ==UserScript==
// @name         Wykres Strefy -> Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID
// @match        https://prod.news.systemygemini.pl/ords/r/webapi/news_wms_desktop/replenishments1*
// @match        https://prod.news.systemygemini.pl/ords/r/webapi/news_wms_desktop/current-placements-and-replenishments*
// @match        https://prod.news.systemygemini.pl/ords/r/webapi/news_wms_desktop/waiting-for-replenishment*
// @require      https://cdn.jsdelivr.net/npm/chart.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let chartDiv = null;
    let chartInstance = null;
    let aktywnyStatus = "Gotowy";

    const normalize = txt => txt?.trim().toLowerCase() || '';

    /**
     * Extracts the current APEX session ID from the page URL.  When a user logs into
     * the WMS, each page includes a `session=<id>` query parameter.  Some reports
     * cannot be fetched without including this parameter.  If the parameter is
     * missing (for example, when using path-only APIs that rely solely on cookies),
     * this function returns an empty string.
     */
    function getCurrentSession() {
        try {
            const url = new URL(window.location.href);
            return url.searchParams.get('session') || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * When the script runs on the "current-placements-and-replenishments" page, it
     * extracts the JT data directly from the DOM and stores it in localStorage.
     * This bypasses the X-Frame-Options restriction and allows the main report
     * page to read the data later.  Once the data is saved, no further action
     * is taken on this page.
     */
    const currentPath = window.location.pathname || '';
    if (currentPath.includes('/current-placements-and-replenishments')) {
        // Poll until the interactive report is populated
        const start = Date.now();
        const timeout = 15000;
        const poller = setInterval(() => {
            const headerLinks = Array.from(document.querySelectorAll('.a-IRR-headerLink'));
            const rows = Array.from(document.querySelectorAll('.a-IRR-table tbody tr'));
            if (headerLinks.length && rows.length) {
                clearInterval(poller);
                // Determine column indexes
                const idxSkuId = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;
                const idxSkuAlt = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
                const idxCurrentAddr = headerLinks.find(h => normalize(h.textContent) === 'current addr')?.dataset.fhtColumnIdx;
                const idxJT = headerLinks.find(h => normalize(h.textContent) === 'jt')?.dataset.fhtColumnIdx;
                const skuIdx = idxSkuId !== undefined ? idxSkuId : idxSkuAlt;
                if ([skuIdx, idxCurrentAddr, idxJT].some(i => i === undefined)) {
                    return;
                }
                const placementsMap = {};
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    const skuId = (cells[skuIdx]?.textContent || '').trim();
                    const addr = (cells[idxCurrentAddr]?.textContent || '').trim();
                    const jt = (cells[idxJT]?.textContent || '').trim();
                    if (!skuId || !addr || !jt) return;
                    if (!placementsMap[skuId]) placementsMap[skuId] = [];
                    placementsMap[skuId].push({ addr, jt });
                });
                try {
                    // Zapisz zebrane dane JT do localStorage.  Dodajemy także
                    // znacznik czasu wygaśnięcia na 5 minut (300 000 ms).  Po
                    // przekroczeniu tego czasu dane zostaną uznane za
                    // nieaktualne i usunięte przy odczycie.
                    localStorage.setItem('placementsData', JSON.stringify(placementsMap));
                    const expiry = Date.now() + 15 * 60 * 1000; // 15 minut
                    localStorage.setItem('placementsDataExpiry', String(expiry));
                    console.log('[Wykres Strefy] Dane JT zapisane do localStorage (ważne 5 minut).');
                    // Dodatkowa funkcja usuwająca dane po upływie 5 minut na
                    // wypadek, gdyby użytkownik pozostawał na stronie.  Nie
                    // działa po przeładowaniu strony, dlatego właściwy
                    // mechanizm wygaszania jest zaimplementowany przy odczycie.
                    setTimeout(() => {
                        const currentExpiry = localStorage.getItem('placementsDataExpiry');
                        if (currentExpiry && Date.now() > Number(currentExpiry)) {
                            localStorage.removeItem('placementsData');
                            localStorage.removeItem('placementsDataExpiry');
                        }
                    }, 15 * 60 * 1000);
                } catch (e) {
                    console.error('[Wykres Strefy] Nie udało się zapisać danych JT:', e);
                }
            } else if (Date.now() - start > timeout) {
                clearInterval(poller);
            }
        }, 500);
        return;
    }

    /**
     * When the script runs on the "waiting-for-replenishment" page, parse the
     * interactive report for columns "Id SKU" (or "SKU ID") and
     * "Liczba zamówień oczekujących", then store the result in localStorage
     * under the key `waitingData`.  Include an expiry of 5 minutes.  This
     * avoids the X-Frame-Options restriction by requiring the user to open
     * this page directly once in a while.
     */
    if (currentPath.includes('/waiting-for-replenishment')) {
        const start = Date.now();
        const timeoutMs = 15000;
        const pollWaiting = setInterval(() => {
            const headerLinks = Array.from(document.querySelectorAll('.a-IRR-headerLink'));
            const rows = Array.from(document.querySelectorAll('.a-IRR-table tbody tr'));
            if (headerLinks.length && rows.length) {
                clearInterval(pollWaiting);
                // Determine column indexes.  Attempt to match a variety of header
                // names for the SKU identifier and the pending count.  First try
                // exact matches using normalize(), then fall back to more
                // permissive checks if needed.
                const idxSkuIdExact = headerLinks.find(h => normalize(h.textContent) === 'id sku')?.dataset.fhtColumnIdx;
                const idxSkuIdAlt = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;
                const idxSkuOnly = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
                const skuIdx = idxSkuIdExact !== undefined ? idxSkuIdExact : (idxSkuIdAlt !== undefined ? idxSkuIdAlt : idxSkuOnly);
                // For count, try to find header containing "liczba" and "oczek" or "zamow"
                let countIdx;
                const countCandidate = headerLinks.find(h => {
                    const t = h.textContent.trim().toLowerCase();
                    return t.includes('liczba') && (t.includes('oczek') || t.includes('zamow'));
                });
                if (countCandidate) countIdx = countCandidate.dataset.fhtColumnIdx;
                if ([skuIdx, countIdx].some(i => i === undefined)) {
                    return;
                }
                const waitingList = [];
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    const idSku = (cells[skuIdx]?.textContent || '').trim();
                    let raw = (cells[countIdx]?.textContent || '').replace(/\s+/g,'').replace(',', '.');
                    const parsed = parseFloat(raw);
                    const count = Number.isFinite(parsed) ? Math.round(parsed) : (parseInt(raw,10) || 0);
                    if (!idSku || count <= 0) return;
                    waitingList.push({ id: idSku, count });
                });
                try {
                    localStorage.setItem('waitingData', JSON.stringify(waitingList));
                    const expiry = Date.now() + 15 * 60 * 1000;
                    localStorage.setItem('waitingDataExpiry', String(expiry));
                    console.log('[Wykres Strefy] Dane waiting-for-replenishment zapisane (ważne 5 minut).');
                    // Schedule automatic removal after expiry to keep data fresh
                    setTimeout(() => {
                        const exp = localStorage.getItem('waitingDataExpiry');
                        if (exp && Date.now() > Number(exp)) {
                            localStorage.removeItem('waitingData');
                            localStorage.removeItem('waitingDataExpiry');
                        }
                    }, 15 * 60 * 1000);
                } catch (e) {
                    console.error('[Wykres Strefy] Nie udało się zapisać danych waiting-for-replenishment:', e);
                }
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(pollWaiting);
            }
        }, 500);
        return;
    }

    // Jeśli znajdujemy się na głównej stronie raportu (replenishments1), skonfiguruj
    // automatyczne sprawdzanie ważności danych JT i waiting.  Jeżeli dane są
    // nieobecne lub przeterminowane, zostaną odświeżone w ukrytej karcie.
    if (currentPath.includes('/replenishments1')) {
        function autoRefreshCheck() {
            const now = Date.now();
            let need = false;
            const pExpiry = localStorage.getItem('placementsDataExpiry');
            if (!pExpiry || now > Number(pExpiry)) need = true;
            const wExpiry = localStorage.getItem('waitingDataExpiry');
            if (!wExpiry || now > Number(wExpiry)) need = true;
            if (need) {
                odswiezWszystkieDane();
            }
        }
        // Wykonaj pierwszy check natychmiast po załadowaniu strony
        autoRefreshCheck();
        // Sprawdzaj co 15 minut (900000 ms)
        setInterval(autoRefreshCheck, 5 * 60 * 1000);
    }

    function pobierzDane(statusFilter = null) {
        const headerLinks = Array.from(document.querySelectorAll('.a-IRR-headerLink'));
        if (!headerLinks.length) return null;

        const idxStrefa = headerLinks.find(h => normalize(h.textContent) === 'strefa')?.dataset.fhtColumnIdx;
        const idxSku = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
        const idxZamSku = headerLinks.find(h => normalize(h.textContent).includes('liczba zamówień'))?.dataset.fhtColumnIdx;
        const idxStatus = headerLinks.find(h => normalize(h.textContent) === 'status')?.dataset.fhtColumnIdx;
        const idxSkuId = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;

        if ([idxStrefa, idxSku, idxZamSku, idxStatus, idxSkuId].some(i => i === undefined)) return null;

        const rows = document.querySelectorAll('.a-IRR-table tbody tr');
        const globalSku = {};

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            const strefa = (cells[idxStrefa]?.textContent || '').trim();
            const sku = (cells[idxSku]?.textContent || '').trim();
            const skuId = (cells[idxSkuId]?.textContent || '').trim();
            let rawZ = (cells[idxZamSku]?.textContent || '').replace(/\s+/g,'').replace(',', '.');
            const parsed = parseFloat(rawZ);
            const zamowienia = Number.isFinite(parsed) ? Math.round(parsed) : (parseInt(rawZ,10) || 0);
            const status = (cells[idxStatus]?.textContent || '').trim();

            if (!strefa || !sku || !status) return;

            if (!globalSku[sku]) {
                globalSku[sku] = { status, strefa, zamowienia, id: skuId };
                return;
            }

            const existing = globalSku[sku];
            if (status === "Przetwarzane" && existing.status === "Gotowy") {
                globalSku[sku] = { status, strefa, zamowienia, id: skuId };
            }
        });

        const strefaSkuMap = {};
        Object.entries(globalSku).forEach(([sku, obj]) => {
            if (statusFilter && obj.status !== statusFilter) return;
            if (!strefaSkuMap[obj.strefa]) strefaSkuMap[obj.strefa] = {};
            strefaSkuMap[obj.strefa][sku] = obj;
        });

        const strefy = {};
        for (const s in strefaSkuMap) {
            strefy[s] = Object.values(strefaSkuMap[s]).reduce((a,b)=>a+b.zamowienia,0);
        }

        const posortowane = Object.entries(strefy).sort((a,b)=>b[1]-a[1]);
        const suma = posortowane.reduce((acc,[_,v])=>acc+v,0);

        return {
            etykiety: posortowane.map(([s]) => s),
            wartosci: posortowane.map(([_,v]) => v),
            procenty: posortowane.map(([_,v]) => suma ? ((v/suma)*100).toFixed(1)+'%' : '0.0%'),
            suma,
            strefaSkuMap
        };
    }

    function eksportCSV(etykiety, wartosci, procenty) {
        let csv = 'Strefa;Suma zamówień;Udział %\n';
        etykiety.forEach((s,i) => csv += `${s};${wartosci[i]};${procenty[i]}\n`);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'wykres_stref.csv';
        link.click();
    }

    function przypiszOperatora(strefa) {
        const operator = prompt(`Podaj operatora dla strefy "${strefa}" (puste = usuń):`);
        let przypisania = JSON.parse(localStorage.getItem('operatorzyStref') || '{}');
        if (!operator) delete przypisania[strefa];
        else przypisania[strefa] = operator;
        localStorage.setItem('operatorzyStref', JSON.stringify(przypisania));
        stworzWykres();
    }

    function usunOperatorow() {
        localStorage.removeItem('operatorzyStref');
        stworzWykres();
    }

    // Additional state for JT chart popup
    // jtChartDiv holds the DOM element for the JT popup, jtChartInstance is the Chart.js instance for the JT chart.
    let jtChartDiv = null;
    let jtChartInstance = null;

    /**
     * Otwiera nową niewidoczną kartę z podanym adresem URL, czeka aż
     * interaktywny raport zostanie wyrenderowany, następnie parsuje
     * wiersze tabeli i zwraca wynik w formie obiektu.  Funkcja
     * zamyka okno po zakończeniu.  Przydatne do obejścia nagłówka
     * X-Frame-Options: DENY, który uniemożliwia wczytanie raportu w
     * iframe.  Jeżeli przeglądarka blokuje wyskakujące okna, zwracany
     * jest pusty obiekt.
     *
     * @param {string} url - pełny adres do raportu
     * @param {function(Document): any} parser - funkcja wywoływana po
     *      załadowaniu raportu, która otrzymuje obiekt document i
     *      zwraca przetworzone dane
     * @returns {Promise<any>}
     */
    function openAndParse(url, parser) {
        return new Promise((resolve) => {
            try {
                const w = window.open(url, '_blank', 'width=10,height=10,left=-9999,top=-9999');
                if (!w) {
                    console.warn('[Wykres Strefy] Nie można otworzyć nowego okna – prawdopodobnie blokada pop-up.');
                    return resolve(null);
                }
                const start = Date.now();
                const timeout = 20000;
                const poll = setInterval(() => {
                    try {
                        const doc = w.document;
                        // Sprawdź, czy raport się wczytał (są nagłówki i wiersze)
                        const headerLinks = doc.querySelectorAll('.a-IRR-headerLink');
                        const rows = doc.querySelectorAll('.a-IRR-table tbody tr');
                        if (headerLinks.length && rows.length) {
                            clearInterval(poll);
                            const result = parser(doc);
                            w.close();
                            resolve(result);
                        } else if (Date.now() - start > timeout) {
                            clearInterval(poll);
                            w.close();
                            console.warn('[Wykres Strefy] Przekroczono czas oczekiwania podczas pobierania danych.');
                            resolve(null);
                        }
                    } catch (ex) {
                        clearInterval(poll);
                        if (w && !w.closed) w.close();
                        console.error('[Wykres Strefy] Błąd podczas parsowania raportu w nowej karcie:', ex);
                        resolve(null);
                    }
                }, 600);
            } catch (ex) {
                console.error('[Wykres Strefy] Nie udało się otworzyć nowej karty:', ex);
                resolve(null);
            }
        });
    }

    /**
     * Pobiera raport "Aktualne zadania zatowarowania i umieszczenia" w ukrytej karcie,
     * parsuje kolumny Sku Id, Current Addr i JT, zapisuje w localStorage
     * (klucz `placementsData`) z nowym okresem ważności i usuwa stare
     * dane.  Zwraca liczbę wczytanych rekordów lub 0 w przypadku problemu.
     */
    async function refreshJTData() {
        try {
            const sess = getCurrentSession();
            const base = `${window.location.origin}/ords/r/webapi/news_wms_desktop/current-placements-and-replenishments`;
            const url = sess ? `${base}?session=${encodeURIComponent(sess)}` : base;
            const result = await openAndParse(url, (doc) => {
                const headerLinks = Array.from(doc.querySelectorAll('.a-IRR-headerLink'));
                const rows = Array.from(doc.querySelectorAll('.a-IRR-table tbody tr'));
                const idxSkuId = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;
                const idxSkuAlt = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
                const idxCurrentAddr = headerLinks.find(h => normalize(h.textContent) === 'current addr')?.dataset.fhtColumnIdx;
                const idxJT = headerLinks.find(h => normalize(h.textContent) === 'jt')?.dataset.fhtColumnIdx;
                const skuIdx = idxSkuId !== undefined ? idxSkuId : idxSkuAlt;
                if ([skuIdx, idxCurrentAddr, idxJT].some(i => i === undefined)) return {};
                const map = {};
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    const skuId = (cells[skuIdx]?.textContent || '').trim();
                    const addr = (cells[idxCurrentAddr]?.textContent || '').trim();
                    const jt = (cells[idxJT]?.textContent || '').trim();
                    if (!skuId || !addr || !jt) return;
                    if (!map[skuId]) map[skuId] = [];
                    map[skuId].push({ addr, jt });
                });
                return map;
            });
            if (result && typeof result === 'object') {
                localStorage.setItem('placementsData', JSON.stringify(result));
                const expiry = Date.now() + 5 * 60 * 1000;
                localStorage.setItem('placementsDataExpiry', String(expiry));
                // ustaw timer czyszczący
                setTimeout(() => {
                    const currentExpiry = localStorage.getItem('placementsDataExpiry');
                    if (currentExpiry && Date.now() > Number(currentExpiry)) {
                        localStorage.removeItem('placementsData');
                        localStorage.removeItem('placementsDataExpiry');
                    }
                }, 5 * 60 * 1000);
                return Object.keys(result).length;
            }
        } catch (e) {
            console.error('[Wykres Strefy] refreshJTData error:', e);
        }
        return 0;
    }

    /**
     * Pobiera raport "waiting-for-replenishment" w ukrytej karcie, parsuje
     * kolumny (Id SKU, Liczba zamówień), zapisuje w localStorage i
     * ustawia znacznik wygaśnięcia.  Zwraca liczbę rekordów lub 0.
     */
    async function refreshWaitingData() {
        try {
            const base = `${window.location.origin}/ords/r/webapi/news_wms_desktop/waiting-for-replenishment`;
            const sess = getCurrentSession();
            const url = sess ? `${base}?session=${encodeURIComponent(sess)}` : base;
            const result = await openAndParse(url, (doc) => {
                const headerLinks = Array.from(doc.querySelectorAll('.a-IRR-headerLink'));
                const rows = Array.from(doc.querySelectorAll('.a-IRR-table tbody tr'));
                // Locate SKU and count columns
                const idxSkuIdExact = headerLinks.find(h => normalize(h.textContent) === 'id sku')?.dataset.fhtColumnIdx;
                const idxSkuIdAlt = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;
                const idxSkuOnly = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
                const skuIdx = idxSkuIdExact !== undefined ? idxSkuIdExact : (idxSkuIdAlt !== undefined ? idxSkuIdAlt : idxSkuOnly);
                let countIdx;
                const countCandidate = headerLinks.find(h => {
                    const t = h.textContent.trim().toLowerCase();
                    return t.includes('liczba') && (t.includes('oczek') || t.includes('zamow'));
                });
                if (countCandidate) countIdx = countCandidate.dataset.fhtColumnIdx;
                if ([skuIdx, countIdx].some(i => i === undefined)) return [];
                const arr = [];
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    const idSku = (cells[skuIdx]?.textContent || '').trim();
                    let raw = (cells[countIdx]?.textContent || '').replace(/\s+/g, '').replace(',', '.');
                    const parsed = parseFloat(raw);
                    const count = Number.isFinite(parsed) ? Math.round(parsed) : (parseInt(raw, 10) || 0);
                    if (!idSku || count <= 0) return;
                    arr.push({ id: idSku, count });
                });
                return arr;
            });
            if (Array.isArray(result)) {
                localStorage.setItem('waitingData', JSON.stringify(result));
                const expiry = Date.now() + 5 * 60 * 1000;
                localStorage.setItem('waitingDataExpiry', String(expiry));
                setTimeout(() => {
                    const exp = localStorage.getItem('waitingDataExpiry');
                    if (exp && Date.now() > Number(exp)) {
                        localStorage.removeItem('waitingData');
                        localStorage.removeItem('waitingDataExpiry');
                    }
                }, 5 * 60 * 1000);
                return result.length;
            }
        } catch (e) {
            console.error('[Wykres Strefy] refreshWaitingData error:', e);
        }
        return 0;
    }

    /**
     * Odświeża zarówno dane JT, jak i raport oczekujących.  Używany
     * przy automatycznym odświeżaniu oraz przez przycisk "Odśwież dane".
     */
    async function odswiezWszystkieDane() {
        // odśwież JT
        const jtCount = await refreshJTData();
        // odśwież waiting
        const waitCount = await refreshWaitingData();
        if (jtCount || waitCount) {
            console.log(`[Wykres Strefy] Odświeżono dane: JT=${jtCount}, waiting=${waitCount}`);
        }
    }

    // Additional function to fetch items waiting for replenishment.  Because the
    // `waiting-for-replenishment` report sets the X-Frame-Options header to
    // `deny`, we cannot load it in an iframe.  Instead, when the user visits
    // that page directly, the script running on that page stores the parsed
    // data in localStorage under the key `waitingData`.  This helper simply
    // retrieves those cached results (if present and not expired) and returns
    // them as an array of { id, count } objects.
    async function pobierzWaitingData() {
        try {
            const expiryStr = localStorage.getItem('waitingDataExpiry');
            const stored = localStorage.getItem('waitingData');
            if (stored) {
                const expiry = expiryStr ? Number(expiryStr) : 0;
                if (expiry && Date.now() > expiry) {
                    // Data expired; remove entries
                    localStorage.removeItem('waitingData');
                    localStorage.removeItem('waitingDataExpiry');
                    return [];
                }
                return JSON.parse(stored) || [];
            }
        } catch (e) {
            console.error('[Wykres Strefy] Błąd odczytu danych waiting-for-replenishment z localStorage:', e);
        }
        return [];
    }

    // Create a popup listing Id SKU values that cannot be matched to known SKU IDs.
    // Each row displays the SKU ID and number of pending orders, and clicking on
    // the SKU ID copies it to the clipboard.  If no unmatched IDs are found,
    // an alert informs the user that all items are known.
    async function pokazBrakDokPopup() {
        const dane = pobierzDane(null);
        if (!dane || !dane.strefaSkuMap) {
            alert('Nie można pobrać danych z raportu zamówień.');
            return;
        }
        // Build a set of known SKU IDs from the main report
        const knownIds = new Set();
        Object.values(dane.strefaSkuMap).forEach(skuObjMap => {
            Object.values(skuObjMap).forEach(obj => {
                if (obj.id) knownIds.add(obj.id);
            });
        });
        const waiting = await pobierzWaitingData();
        if (!waiting || waiting.length === 0) {
            alert('Brak danych z raportu oczekujących na uzupełnienie.');
            return;
        }
        const unmatched = waiting.filter(item => !knownIds.has(item.id));
        if (!unmatched.length) {
            alert('Wszystkie Id SKU posiadają przypisany dokument uzupełnień.');
            return;
        }
        // Create popup container
        const popup = document.createElement('div');
        // The missing-documents popup is deliberately sized larger than the
        // default popups.  Enlarging the width and maximum height by about
        // 50 % gives users more space to view long lists of items.  The
        // transform centres the element in the viewport.  Note that we
        // specify an explicit width so the popup doesn't shrink to fit
        // its contents on narrow screens.
        popup.style = `
            position:fixed;
            top:50%; left:50%;
            transform:translate(-50%,-50%);
            background:#fff;
            padding:24px;
            border:1px solid #ccc;
            border-radius:10px;
            box-shadow:0 8px 24px rgba(0,0,0,0.25);
            width:60%;
            max-height:80%;
            overflow:auto;
            z-index:100003;
            font-family:Arial, sans-serif;
        `;
        const header = document.createElement('div');
        header.textContent = 'Brak dokumentu uzupełnień';
        header.style = 'font-weight:bold;margin-bottom:12px;font-size:18px;color:#333;';
        popup.appendChild(header);
        const closeIcon = document.createElement('div');
        closeIcon.textContent = '✖';
        closeIcon.style = `
            position:absolute; top:8px; right:12px;
            cursor:pointer; font-size:18px; font-weight:bold;
            color:#333;
        `;
        closeIcon.onclick = () => popup.remove();
        popup.appendChild(closeIcon);
        const table = document.createElement('table');
        table.style = `
            border-collapse:collapse;
            width:100%;
            text-align:left;
            font-size:14px;
        `;
        const trh = document.createElement('tr');
        ['Id SKU','Liczba zamówień'].forEach(t => {
            const th = document.createElement('th');
            th.textContent = t;
            th.style = `
                padding:8px;
                border-bottom:2px solid #aaa;
                background:#f0f0f0;
                font-weight:bold;
            `;
            trh.appendChild(th);
        });
        table.appendChild(trh);
        unmatched.forEach((item,i) => {
            const tr = document.createElement('tr');
            tr.style.background = i%2===0?'#fff':'#f9f9f9';
            const tdId = document.createElement('td');
            tdId.textContent = item.id;
            tdId.style = 'padding:6px;border-bottom:1px solid #eee;cursor:pointer;';
            tdId.onclick = () => {
                navigator.clipboard.writeText(item.id).then(() => {
                    // Highlight the entire row when a SKU is copied.  Use a
                    // subtle yellow so it stands out but remains legible.
                    tr.style.background = '#fff3cd';
                    const info = document.createElement('div');
                    info.textContent = 'Skopiowano!';
                    info.style = `
                        position:absolute;
                        top:8px; right:50px;
                        background:#2ecc71;
                        color:#fff;
                        padding:4px 8px;
                        border-radius:4px;
                        font-size:12px;
                        font-weight:bold;
                        opacity:0.95;
                        pointer-events:none;
                        z-index:1003;
                    `;
                    popup.appendChild(info);
                    setTimeout(() => info.remove(), 1500);
                });
            };
            const tdCount = document.createElement('td');
            tdCount.textContent = item.count;
            tdCount.style = 'padding:6px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;';
            tr.appendChild(tdId);
            tr.appendChild(tdCount);
            table.appendChild(tr);
        });
        popup.appendChild(table);
        document.body.appendChild(popup);
        const escHandler = e => {
            if (e.key === 'Escape') {
                popup.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Fetch data from the "current-placements-and-replenishments" page.
     * This helper attempts to retrieve a table from another APEX report using fetch. It parses
     * the returned HTML and extracts the columns "Sku Id", "Current Addr" and "JT".
     *
     * The returned object maps SKU IDs to an array of placement objects { addr, jt }.
     */
    async function pobierzPlacements() {
        return new Promise(resolve => {
            try {
                const base = `${window.location.origin}/ords/r/webapi/news_wms_desktop/current-placements-and-replenishments`;
                const sess = getCurrentSession();
                const src = sess ? `${base}?session=${encodeURIComponent(sess)}` : base;
                // Create a hidden iframe to load the report.  We rely on the page's own
                // scripts to populate the interactive report, which ensures that the
                // table is fully rendered before we attempt to parse it.
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = src;
                document.body.appendChild(iframe);
                const maxWaitMs = 15000; // give up after 15 seconds
                const startTime = Date.now();
                function cleanup(data) {
                    iframe.remove();
                    resolve(data || {});
                }
                iframe.onload = () => {
                    // Poll the iframe document until the interactive report finishes loading
                    const poll = setInterval(() => {
                        const doc = iframe.contentDocument;
                        if (!doc) {
                            if (Date.now() - startTime > maxWaitMs) {
                                clearInterval(poll);
                                cleanup({});
                            }
                            return;
                        }
                        const headerLinks = Array.from(doc.querySelectorAll('.a-IRR-headerLink'));
                        const rows = Array.from(doc.querySelectorAll('.a-IRR-table tbody tr'));
                        if (headerLinks.length && rows.length) {
                            clearInterval(poll);
                            // Determine column indexes based on header text
                            const idxSkuId = headerLinks.find(h => normalize(h.textContent) === 'sku id')?.dataset.fhtColumnIdx;
                            const idxSkuAlt = headerLinks.find(h => normalize(h.textContent) === 'sku')?.dataset.fhtColumnIdx;
                            const idxCurrentAddr = headerLinks.find(h => normalize(h.textContent) === 'current addr')?.dataset.fhtColumnIdx;
                            const idxJT = headerLinks.find(h => normalize(h.textContent) === 'jt')?.dataset.fhtColumnIdx;
                            const skuIdx = idxSkuId !== undefined ? idxSkuId : idxSkuAlt;
                            if ([skuIdx, idxCurrentAddr, idxJT].some(i => i === undefined)) {
                                cleanup({});
                                return;
                            }
                            const placementsMap = {};
                            rows.forEach(row => {
                                const cells = row.querySelectorAll('td');
                                const skuId = (cells[skuIdx]?.textContent || '').trim();
                                const addr = (cells[idxCurrentAddr]?.textContent || '').trim();
                                const jt = (cells[idxJT]?.textContent || '').trim();
                                if (!skuId || !addr || !jt) return;
                                if (!placementsMap[skuId]) placementsMap[skuId] = [];
                                placementsMap[skuId].push({ addr, jt });
                            });
                            cleanup(placementsMap);
                        } else if (Date.now() - startTime > maxWaitMs) {
                            clearInterval(poll);
                            cleanup({});
                        }
                    }, 500);
                };
                // If iframe fails to load within the timeout, resolve empty
                setTimeout(() => {
                    cleanup({});
                }, maxWaitMs);
            } catch (e) {
                console.error('Błąd pobierania danych z JT:', e);
                resolve({});
            }
        });
    }

    /**
     * Build and display a grouped bar chart for JT data.  This function aggregates
     * the number of pending orders (Liczba zamówień oczekujących) by Current Addr
     * and JT across all SKUs.  It opens an overlay popup containing the chart.
     */
    async function stworzJTWykres() {
        // Avoid creating multiple popups
        if (jtChartDiv) return;
        // Retrieve placement data saved in localStorage by the companion script on
        // the 'current-placements-and-replenishments' page.  If no data is found,
        // prompt the user to visit that report first.
        const daneAll = pobierzDane(null);
        if (!daneAll || !daneAll.strefaSkuMap) {
            alert('Nie można pobrać danych z raportu zamówień.');
            return;
        }
        // Flatten strefaSkuMap to a mapping of SKU ID to total pending orders
        const skuCountMap = {};
        Object.values(daneAll.strefaSkuMap).forEach(skuObjMap => {
            Object.values(skuObjMap).forEach(({ id, zamowienia }) => {
                if (!id) return;
                skuCountMap[id] = (skuCountMap[id] || 0) + (zamowienia || 0);
            });
        });
        let placementsMap = {};
        try {
            const expiryStr = localStorage.getItem('placementsDataExpiry');
            const stored = localStorage.getItem('placementsData');
            // Jeśli istnieje znacznik wygaśnięcia, sprawdź czy dane są jeszcze ważne.
            if (stored) {
                const expiry = expiryStr ? Number(expiryStr) : 0;
                if (expiry && Date.now() > expiry) {
                    // Dane przeterminowane – usuń je.
                    localStorage.removeItem('placementsData');
                    localStorage.removeItem('placementsDataExpiry');
                } else {
                    placementsMap = JSON.parse(stored);
                }
            }
        } catch (e) {
            console.error('[Wykres Strefy] Nie można odczytać danych JT z localStorage:', e);
        }
        if (!placementsMap || Object.keys(placementsMap).length === 0) {
            alert('Brak zapisanych danych JT lub są przeterminowane. Otwórz raport "Aktualne zadania zatowarowania i umieszczenia" i poczekaj, aż dane się wczytają.');
            return;
        }
        // Aggregate counts by (addr, jt) once. We'll derive totals per JT on demand.
        const groupCounts = {};
        for (const [skuId, placements] of Object.entries(placementsMap)) {
            const count = skuCountMap[skuId];
            if (!count) continue;
            placements.forEach(({ addr, jt }) => {
                if (!addr || !jt) return;
                if (!groupCounts[addr]) groupCounts[addr] = {};
                groupCounts[addr][jt] = (groupCounts[addr][jt] || 0) + count;
            });
        }
        const addresses = Object.keys(groupCounts);
        if (!addresses.length) {
            alert('Brak danych do wyświetlenia.');
            return;
        }

        /**
         * Transform an email-like address (imie.nazwisko@domena) into a display name
         * "Imie Nazwisko".  If no dot is present the entire part before '@' is
         * capitalised.  Example: "michal.fedczak@gemini.pl" -> "Michal Fedczak".
         */
        function toDisplayName(addr) {
            // Extract the portion before '@'.  If there is no '@', return the
            // address as-is but capitalised.
            const beforeAt = addr.split('@')[0] || addr;
            const parts = beforeAt.split('.');
            return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
        }

        // Determine unique user names and their total counts (sum of all JT counts) across
        // all addresses that look like email.  This will support the
        // "Użytkownicy" filter, which displays bars per user.
        const userCounts = {};
        addresses.forEach(addr => {
            if (addr.includes('@')) {
                const userName = toDisplayName(addr);
                let total = 0;
                Object.values(groupCounts[addr]).forEach(v => { total += v; });
                userCounts[userName] = (userCounts[userName] || 0) + total;
            }
        });
        const userNames = Object.keys(userCounts);

        // Define a color palette for JT bars
        const colorPalette = [
            '#3498db','#e74c3c','#2ecc71','#9b59b6','#f1c40f','#e67e22','#1abc9c','#e84393','#16a085','#fd79a8'
        ];
        /**
         * Compute counts per JT for the given address filter. If `filterAddr` is null,
         * sums all addresses. Returns an array of { jt, count } objects sorted
         * descending by count.
         */
        function computeSorted(filterAddr) {
            // Special handling for the "users" filter: aggregate by user names instead
            // of JT.  When filterAddr === '__USERS__', compute total counts per
            // user across all their addresses.  Otherwise, behave as before and
            // aggregate counts per JT for the selected address.
            if (filterAddr === '__USERS__') {
                // Build an array of { jt: userName, count: totalCount } sorted descending.
                return Object.entries(userCounts)
                    .map(([name, count]) => ({ jt: name, count }))
                    .sort((a, b) => b.count - a.count);
            }
            const countsByJT = {};
            if (!filterAddr) {
                addresses.forEach(addr => {
                    Object.entries(groupCounts[addr]).forEach(([jt, val]) => {
                        countsByJT[jt] = (countsByJT[jt] || 0) + val;
                    });
                });
            } else {
                Object.entries(groupCounts[filterAddr] || {}).forEach(([jt, val]) => {
                    countsByJT[jt] = val;
                });
            }
            return Object.entries(countsByJT)
                .map(([jt, count]) => ({ jt, count }))
                .sort((a, b) => b.count - a.count);
        }
        // Create popup container
        jtChartDiv = document.createElement('div');
        jtChartDiv.style = `
            position:fixed;
            top:50%; left:50%;
            transform:translate(-50%, -50%);
            width:80%; height:80%;
            background:#fff;
            border:1px solid #ccc;
            border-radius:8px;
            box-shadow:0 8px 24px rgba(0,0,0,0.25);
            z-index:100001;
            display:flex;
            flex-direction:column;
        `;
        // Header with title, filter buttons and close
        const header = document.createElement('div');
        header.style = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #ddd;';
        // Left part: title
        const title = document.createElement('div');
        title.textContent = 'Podział zamówień wg JT';
        title.style = 'font-weight:bold;font-size:16px;margin-right:auto;';
        header.appendChild(title);
        // Middle part: filter buttons container
        const filterContainer = document.createElement('div');
        filterContainer.style = 'display:flex;flex-wrap:wrap;gap:6px;';
        header.appendChild(filterContainer);
        // Right part: close button
        const closeBtn = document.createElement('div');
        closeBtn.textContent = '✖';
        closeBtn.style = 'cursor:pointer;font-size:18px;font-weight:bold;';
        closeBtn.onclick = () => {
            if (jtChartInstance) jtChartInstance.destroy();
            jtChartInstance = null;
            jtChartDiv.remove();
            jtChartDiv = null;
        };
        header.appendChild(closeBtn);
        jtChartDiv.appendChild(header);
        // Chart container
        const canvasContainer = document.createElement('div');
        canvasContainer.style = 'flex:1;position:relative;padding:12px;';
        const canvas = document.createElement('canvas');
        canvasContainer.appendChild(canvas);
        jtChartDiv.appendChild(canvasContainer);
        document.body.appendChild(jtChartDiv);
        // Track the currently selected address for datalabel display
        let currentFilterAddr = null;

        // Map of SKU ID to name and total pending orders, derived from daneAll
        const skuInfoMap = {};
        Object.values(daneAll.strefaSkuMap).forEach(skuObjMap => {
            Object.entries(skuObjMap).forEach(([skuName, obj]) => {
                const id = obj.id;
                if (!id) return;
                skuInfoMap[id] = { name: skuName, count: skuCountMap[id] || obj.zamowienia };
            });
        });
        // Initialize chart selecting a sensible default address.  Prefer the
        // first non-user address; if none exist, fall back to the special
        // "__USERS__" filter to show aggregated user data.
        {
            // Determine default filter: first address without '@' or '__USERS__'
            let defaultAddr = addresses.find(a => !a.includes('@'));
            if (!defaultAddr) {
                defaultAddr = '__USERS__';
            }
            currentFilterAddr = defaultAddr;
            const initial = computeSorted(currentFilterAddr);
            const initLabels = initial.map(o => o.jt);
            const initData = initial.map(o => o.count);
            jtChartInstance = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: initLabels,
                    datasets: [{
                        label: 'Liczba zamówień',
                        data: initData,
                        backgroundColor: initLabels.map((_, idx) => colorPalette[idx % colorPalette.length])
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { ticks: { autoSkip: false } },
                        y: { beginAtZero: true, max: (initData.length ? Math.max(...initData) + 3 : 3) }
                    },
                    plugins: {
                        legend: { display: false },
                        datalabels: {
                            anchor: 'end',
                            align: 'end',
                            color: '#000',
                            font: { weight: 'bold' },
                            formatter: function(value) {
                                return `${value}`;
                            }
                        }
                    },
                    animation: {
                        duration: 0,
                        onComplete: () => {
                            drawIcons();
                        }
                    }
                },
                plugins: [ChartDataLabels]
            });
            // Draw icons immediately after the chart is created.  Without this,
            // the search icons would only appear after the user changes the
            // filter, because the icons are normally drawn in the `onComplete`
            // handler.  Scheduling a zero-delay timeout ensures the chart
            // finishes its initial rendering before we place the icons.
            setTimeout(() => {
                drawIcons();
            }, 0);
        }
        // Build filter buttons
        function renderFilterButtons(selected) {
            filterContainer.innerHTML = '';
            const addBtn = (label, addr) => {
                const btn = document.createElement('button');
                btn.textContent = label;
                btn.style = `padding:6px 10px;border-radius:6px;border:1px solid ${selected===addr? '#2980b9':'#bbb'};background:${selected===addr? '#3498db':'#f7f7f7'};color:${selected===addr? '#fff':'#333'};font-size:13px;cursor:pointer;`;
                btn.onclick = () => {
                    // Update current filter for datalabel formatting
                    currentFilterAddr = addr;
                    const sorted = computeSorted(addr);
                    const labels = sorted.map(o => o.jt);
                    const values = sorted.map(o => o.count);
                    jtChartInstance.data.labels = labels;
                    jtChartInstance.data.datasets[0].data = values;
                    jtChartInstance.data.datasets[0].backgroundColor = labels.map((_, idx) => colorPalette[idx % colorPalette.length]);
                    // Adjust Y axis max to be 3 units larger than largest value
                    const maxVal = values.length ? Math.max(...values) : 0;
                    jtChartInstance.options.scales.y.max = maxVal + 3;
                    jtChartInstance.update();
                    // Immediately reposition icons after the dataset is updated.  Using
                    // a timeout ensures the chart has fully re-rendered before we
                    // attempt to draw custom elements like the magnifying glass.  This
                    // avoids race conditions where icons appear to "chase" the bars
                    // for a second or two after switching filters.
                    setTimeout(() => {
                        drawIcons();
                    }, 0);
                    renderFilterButtons(addr);
                };
                filterContainer.appendChild(btn);
            };
            // Add a button to view aggregated user data if there are any users
            if (userNames.length) {
                addBtn('Użytkownicy', '__USERS__');
            }
            // Create buttons for each non-user address (no 'All' filter).  User
            // addresses are represented by the single "Użytkownicy" button,
            // therefore we exclude addresses containing '@' from the list.
            addresses.forEach(addr => {
                if (!addr.includes('@')) {
                    addBtn(addr, addr);
                }
            });
        }
        // Popup for JT details
        function showJTDetailsPopup(addr, jt) {
            // Build a list of SKU details for the given combination.  If the
            // filter represents the special "users" category (addr === '__USERS__'),
            // then `jt` holds the user display name and we must aggregate
            // all SKUs assigned to that user across all addresses.  Otherwise,
            // build a list of SKUs for the specified address and JT as before.
            const details = [];
            if (addr === '__USERS__') {
                const userName = jt;
                for (const [skuId, placements] of Object.entries(placementsMap)) {
                    const info = skuInfoMap[skuId];
                    if (!info) continue;
                    // If any placement for this SKU belongs to the selected user, include it
                    let belongs = false;
                    placements.forEach(p => {
                        if (p.addr && p.addr.includes('@')) {
                            const disp = toDisplayName(p.addr);
                            if (disp === userName) {
                                belongs = true;
                            }
                        }
                    });
                    if (belongs) {
                        details.push({ id: skuId, name: info.name, count: info.count });
                    }
                }
            } else {
                for (const [skuId, placements] of Object.entries(placementsMap)) {
                    const info = skuInfoMap[skuId];
                    if (!info) continue;
                    placements.forEach(p => {
                        if (p.addr === addr && p.jt === jt) {
                            details.push({ id: skuId, name: info.name, count: info.count });
                        }
                    });
                }
            }
            if (!details.length) return;
            // Sort descending by count
            details.sort((a, b) => b.count - a.count);
            // Create popup container
            const popup = document.createElement('div');
            popup.style = `
                position:fixed;
                top:50%; left:50%;
                transform:translate(-50%,-50%);
                background:#fff;
                padding:16px;
                border:1px solid #ccc;
                border-radius:10px;
                box-shadow:0 8px 24px rgba(0,0,0,0.25);
                max-height:70%;
                overflow:auto;
                z-index:100002;
                font-family:Arial, sans-serif;
            `;
            const header = document.createElement('div');
            if (addr === '__USERS__') {
                header.textContent = `Użytkownik: ${jt}`;
            } else {
                header.textContent = `Adres: ${addr} - JT: ${jt}`;
            }
            header.style = 'font-weight:bold;margin-bottom:12px;font-size:18px;color:#333;';
            popup.appendChild(header);
            const closeIcon = document.createElement('div');
            closeIcon.textContent = '✖';
            closeIcon.style = `
                position:absolute; top:8px; right:12px;
                cursor:pointer; font-size:18px; font-weight:bold;
                color:#333;
            `;
            closeIcon.onclick = () => popup.remove();
            popup.appendChild(closeIcon);
            const table = document.createElement('table');
            table.style = `
                border-collapse:collapse;
                width:100%;
                text-align:left;
                font-size:14px;
            `;
            const trh = document.createElement('tr');
            ['SKU ID','Nazwa','Zamówienia'].forEach(t => {
                const th = document.createElement('th');
                th.textContent = t;
                th.style = `
                    padding:8px;
                    border-bottom:2px solid #aaa;
                    background:#f0f0f0;
                    font-weight:bold;
                `;
                trh.appendChild(th);
            });
            table.appendChild(trh);
            details.forEach((item,i) => {
                const tr = document.createElement('tr');
                tr.style.background = i%2===0?'#fff':'#f9f9f9';
                const tdId = document.createElement('td');
                tdId.textContent = item.id;
                tdId.style = 'padding:6px;border-bottom:1px solid #eee;cursor:pointer;';
                tdId.onclick = () => {
                    navigator.clipboard.writeText(item.id).then(() => {
                        // Highlight row after copying to provide visual feedback
                        tr.style.background = '#fff3cd';
                        const info = document.createElement('div');
                        info.textContent = 'Skopiowano!';
                        info.style = `
                            position:absolute;
                            top:8px; right:50px;
                            background:#2ecc71;
                            color:#fff;
                            padding:4px 8px;
                            border-radius:4px;
                            font-size:12px;
                            font-weight:bold;
                            opacity:0.95;
                            pointer-events:none;
                            z-index:1003;
                        `;
                        popup.appendChild(info);
                        setTimeout(() => info.remove(), 1500);
                    });
                };
                const tdName = document.createElement('td');
                tdName.textContent = item.name;
                tdName.style = 'padding:6px;border-bottom:1px solid #eee;';
                const tdCount = document.createElement('td');
                tdCount.textContent = item.count;
                tdCount.style = 'padding:6px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;';
                tr.appendChild(tdId);
                tr.appendChild(tdName);
                tr.appendChild(tdCount);
                table.appendChild(tr);
            });
            popup.appendChild(table);
            document.body.appendChild(popup);
            const escHandler = e => {
                if (e.key === 'Escape') {
                    popup.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        }
        // Helper to draw search icons on bars
        function drawIcons() {
            if (!jtChartInstance || !canvasContainer || !jtChartDiv) return;
            // Remove existing icons before redrawing
            canvasContainer.querySelectorAll('.jt-icon').forEach(el => el.remove());
            // Safely obtain metadata for the first (and only) dataset.  Chart.js
            // may return null if the chart has been destroyed or not yet
            // initialized.  Guard against this to avoid TypeErrors reported by
            // users in the console.
            const meta = jtChartInstance.getDatasetMeta && jtChartInstance.getDatasetMeta(0);
            if (!meta || !meta.data) return;
            meta.data.forEach((bar, i) => {
                if (!bar) return;
                const jtLabel = jtChartInstance.data.labels[i];
                const icon = document.createElement('div');
                icon.className = 'jt-icon';
                icon.textContent = '🔍';
                // Position the search icon inside the bar near the bottom.  The
                // Chart.js bar element exposes a `base` property which
                // represents the y-coordinate of the baseline (bottom) of the
                // bar.  We subtract 30px to place the icon roughly 30
                // pixels above the bottom of the bar, keeping it inside the
                // colored rectangle.  `bar.x` is the horizontal center of the
                // bar.
                const yPos = bar.base - 30;
                icon.style.cssText = `
                    position:absolute;
                    left:${bar.x}px;
                    top:${yPos}px;
                    transform:translate(-50%,0);
                    cursor:pointer;
                    font-size:16px;
                    z-index:1002;
                    color:#000;
                `;
                icon.onclick = () => showJTDetailsPopup(currentFilterAddr, jtLabel);
                canvasContainer.appendChild(icon);
            });
        }
        // Render buttons for default selection
        renderFilterButtons(currentFilterAddr);
    }

    function pokazSkuPopup(strefa, skuMap) {
        const div = document.createElement('div');
        div.style = `
            position:fixed;
            top:50%;left:50%;
            transform:translate(-50%,-50%);
            background:#fff;
            padding:16px;
            border:1px solid #ccc;
            border-radius:10px;
            box-shadow:0 8px 24px rgba(0,0,0,0.25);
            max-height:70%;
            overflow:auto;
            z-index:100000;
            font-family:Arial, sans-serif;
        `;

        const header = document.createElement('div');
        header.textContent = `Strefa: ${strefa}`;
        header.style = "font-weight:bold;margin-bottom:12px;font-size:18px;color:#333;";
        div.appendChild(header);

        const closeIcon = document.createElement('div');
        closeIcon.textContent = "✖";
        closeIcon.style = `
            position:absolute; top:8px; right:12px;
            cursor:pointer; font-size:18px; font-weight:bold;
            color:#333;
        `;
        closeIcon.onclick = ()=>div.remove();
        div.appendChild(closeIcon);

        const table = document.createElement('table');
        table.style = `
            border-collapse:collapse;
            width:100%;
            text-align:left;
            font-size:14px;
        `;
        const trh = document.createElement('tr');
        ['SKU', 'SKU ID', 'Zamówienia'].forEach(t => {
            const th = document.createElement('th');
            th.textContent = t;
            th.style = `
                padding:8px;
                border-bottom:2px solid #aaa;
                background:#f0f0f0;
                font-weight:bold;
            `;
            trh.appendChild(th);
        });
        table.appendChild(trh);

        Object.entries(skuMap).sort((a,b)=>b[1].zamowienia - a[1].zamowienia).forEach(([sku,obj],i)=>{
            const tr = document.createElement('tr');
            tr.style.background = i%2===0?'#fff':'#f9f9f9';

            const tdSku = document.createElement('td');
            tdSku.textContent = sku;
            tdSku.style="padding:6px;border-bottom:1px solid #eee;";

            const tdSkuId = document.createElement('td');
            tdSkuId.textContent = obj.id || '';
            tdSkuId.style="padding:6px;border-bottom:1px solid #eee;cursor:pointer;";
            tdSkuId.onclick = () => {
                navigator.clipboard.writeText(tdSkuId.textContent).then(()=>{
                    // Highlight the row after copying to provide visual feedback
                    tr.style.background = '#fff3cd';
                    const info = document.createElement('div');
                    info.textContent = "Skopiowano!";
                    info.style = `
                        position:absolute;
                        top:8px; right:50px;
                        background:#2ecc71;
                        color:#fff;
                        padding:4px 8px;
                        border-radius:4px;
                        font-size:12px;
                        font-weight:bold;
                        opacity:0.95;
                        pointer-events:none;
                        z-index:1001;
                    `;
                    div.appendChild(info);
                    setTimeout(()=>info.remove(),1500);
                });
            };

            const tdZam = document.createElement('td');
            tdZam.textContent = obj.zamowienia;
            tdZam.style="padding:6px;border-bottom:1px solid #eee;font-weight:bold;text-align:center;";

            tr.appendChild(tdSku);
            tr.appendChild(tdSkuId);
            tr.appendChild(tdZam);

            table.appendChild(tr);
        });

        div.appendChild(table);

        document.body.appendChild(div);

        // ESC zamyka popup
        const escListener = e => { if(e.key==="Escape"){div.remove(); document.removeEventListener('keydown',escListener);} };
        document.addEventListener('keydown',escListener);
    }

    Chart.register({
        id: 'operatorTooltipPlugin',
        afterDraw: chart => {
            const przypisania = JSON.parse(localStorage.getItem('operatorzyStref') || '{}');
            const canvasContainer = chart.canvas.parentElement;
            Array.from(canvasContainer.querySelectorAll('.operator-div')).forEach(div => div.remove());

            const meta = chart.getDatasetMeta(0);
            meta.data.forEach((bar,i)=>{
                const strefa = chart.data.labels[i];
                if (!przypisania[strefa]) return;
                const div = document.createElement('div');
                div.className='operator-div';
                div.textContent=przypisania[strefa];
                div.style.cssText=`
                    position:absolute;
                    left:${bar.x}px;
                    top:${bar.y+6}px;
                    transform:translateX(-50%);
                    color:#fff;
                    font-weight:700;
                    font-size:12px;
                    pointer-events:none;
                    z-index:1000;
                    text-shadow:0 1px 2px rgba(0,0,0,0.6);
                `;
                canvasContainer.appendChild(div);
            });
        }
    });

async function stworzWykres() {
        const check = setInterval(()=>{
        const dane = pobierzDane(aktywnyStatus);
            if (!dane) return;
            clearInterval(check);

            const { etykiety, wartosci, procenty, strefaSkuMap } = dane;
            const przypisania = JSON.parse(localStorage.getItem('operatorzyStref') || '{}');

            if (chartInstance) chartInstance.destroy();
            if (chartDiv) chartDiv.remove();

            chartDiv=document.createElement("div");
            chartDiv.style=`
                position: fixed;
                top:10px; left:10px; right:10px; bottom:10px;
                background:#fff;
                z-index:99999;
                padding:10px;
                border:1px solid #ccc;
                border-radius:8px;
                display:flex;
                flex-direction:column;
                box-shadow:0 6px 18px rgba(0,0,0,0.12);
            `;

            const topBar=document.createElement("div");
            topBar.style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;";
            chartDiv.appendChild(topBar);

            const btns=document.createElement("div");
            btns.style="display:flex;gap:8px;align-items:center;";
            topBar.appendChild(btns);

            function btnStyle(active){return `padding:8px 10px;font-size:14px;cursor:pointer;border-radius:6px;border:${active?'2px solid #333':'1px solid #bbb'};background:${active?'#eef':'#fff'};box-shadow:${active?'inset 0 -2px 0 rgba(0,0,0,0.05)':'none'};`}
            function basicButton(){return `padding:8px 10px;font-size:14px;cursor:pointer;border-radius:6px;border:1px solid #bbb;background:#fff;`}
            function makeBadge(text,colorText='#000',bg='#eee',borderColor=null){const b=document.createElement('div');b.textContent=text;b.style=`padding:6px 10px;border-radius:14px;font-size:13px;font-weight:600;color:${colorText};background:${bg};border:${borderColor?'1px solid '+borderColor:'1px solid rgba(0,0,0,0.06)'};box-shadow:0 2px 6px rgba(0,0,0,0.04);white-space:nowrap;`;return b;}

            const btnWszystkie=document.createElement("button"); btnWszystkie.textContent="📊 Wszystkie"; btnWszystkie.style=btnStyle(aktywnyStatus===null); btnWszystkie.onclick=()=>{aktywnyStatus=null;stworzWykres();}; btns.appendChild(btnWszystkie);
            const btnGotowy=document.createElement("button"); btnGotowy.textContent="🟩 Gotowy"; btnGotowy.style=btnStyle(aktywnyStatus==="Gotowy"); btnGotowy.onclick=()=>{aktywnyStatus="Gotowy";stworzWykres();}; btns.appendChild(btnGotowy);
            const btnPrzet=document.createElement("button"); btnPrzet.textContent="🟧 Przetwarzane"; btnPrzet.style=btnStyle(aktywnyStatus==="Przetwarzane"); btnPrzet.onclick=()=>{aktywnyStatus="Przetwarzane";stworzWykres();}; btns.appendChild(btnPrzet);
            const exportButton=document.createElement("button"); exportButton.textContent="⬇️ Eksport CSV"; exportButton.style=basicButton(); exportButton.onclick=()=>eksportCSV(etykiety,wartosci,procenty); btns.appendChild(exportButton);
            const deleteButton=document.createElement("button");
            deleteButton.textContent="❌ Usuń operatorów";
            deleteButton.style=basicButton();
            deleteButton.onclick=usunOperatorow;
            btns.appendChild(deleteButton);

            // Button to display JT chart popup. When clicked, it calls the asynchronous
            // function stworzJTWykres defined at the top level.
            const jtButton=document.createElement("button");
            jtButton.textContent="📍 Pokaż JT";
            jtButton.style=basicButton();
            jtButton.onclick=()=>{
                // Ensure asynchronous action is handled.  The chart is only created once per invocation.
                stworzJTWykres();
            };
            btns.appendChild(jtButton);

            // Button to check for SKUs waiting for replenishment without a document
            const brakDokButton=document.createElement("button");
            brakDokButton.textContent="🗂️ Brak dokumentu uzu";
            brakDokButton.style=basicButton();
            brakDokButton.onclick=()=>{
                pokazBrakDokPopup();
            };
            btns.appendChild(brakDokButton);

            // Button to refresh both JT and waiting-for-replenishment data on demand
            const refreshButton=document.createElement("button");
            refreshButton.textContent="🔄 Odśwież dane";
            refreshButton.style=basicButton();
            refreshButton.onclick=()=>{
                // Disable button temporarily to prevent multiple clicks
                refreshButton.disabled = true;
                refreshButton.textContent = '⏳ Odświeżanie…';
                odswiezWszystkieDane().finally(() => {
                    // Re-enable button and update label
                    refreshButton.disabled = false;
                    refreshButton.textContent = '🔄 Odśwież dane';
                    // Po odświeżeniu można na nowo zbudować wykres, aby uwzględnić nowe dane
                    stworzWykres();
                });
            };
            btns.appendChild(refreshButton);

            const summaryInline=document.createElement("div"); summaryInline.style="margin-left:auto;display:flex;gap:8px;align-items:center;";
            const daneGot = pobierzDane("Gotowy"); const danePrzet = pobierzDane("Przetwarzane");
            const gotVal = daneGot?daneGot.wartosci.reduce((a,b)=>a+b,0):0;
            const przetVal = danePrzet?danePrzet.wartosci.reduce((a,b)=>a+b,0):0;
            const totalTwo = gotVal + przetVal;
            const pct=v=>totalTwo?((v/totalTwo)*100).toFixed(1):'0.0';
            summaryInline.appendChild(makeBadge(`Łącznie: ${totalTwo}`,'#222','#f0f0f0'));
            summaryInline.appendChild(makeBadge(`Gotowy: ${gotVal} (${pct(gotVal)}%)`,'#fff','#2ecc71','#0a5'));
            summaryInline.appendChild(makeBadge(`Przetwarzane: ${przetVal} (${pct(przetVal)}%)`,'#fff','#f39c12','#8a4b00'));
            // --- Additional counters for specific current addresses ---
            // Attempt to compute counts per selected current address (users, GTW_IN_DTW, GTW_IN_DA1, GTW_DPK)
            try {
                const expiryStr = localStorage.getItem('placementsDataExpiry');
                const stored = localStorage.getItem('placementsData');
                // Use only if placements data is present and not expired
                let placements = null;
                if (stored) {
                    const expiry = expiryStr ? Number(expiryStr) : 0;
                    if (!expiry || Date.now() <= expiry) {
                        placements = JSON.parse(stored);
                    }
                }
                if (placements && przetVal > 0) {
                    // Build a SKU count map based on the "Przetwarzane" status.  The
                    // strefaSkuMap structure groups by strefa and then by SKU
                    // name; we need to sum zamowienia for all SKUs.  This is
                    // equivalent to skuCountMap in stworzJTWykres but limited
                    // to the "Przetwarzane" status.
                    const skuCountMap = {};
                    if (danePrzet && danePrzet.strefaSkuMap) {
                        Object.values(danePrzet.strefaSkuMap).forEach(skuObjMap => {
                            Object.values(skuObjMap).forEach(({ id, zamowienia }) => {
                                if (!id) return;
                                skuCountMap[id] = (skuCountMap[id] || 0) + (zamowienia || 0);
                            });
                        });
                    }
                    // Initialize counters
                    const counter = { USERS: 0, GTW_IN_DTW: 0, GTW_IN_DA1: 0, GTW_IN_DPK: 0 };
                    // Iterate through placements and sum counts for each category
                    Object.entries(placements).forEach(([skuId, places]) => {
                        const c = skuCountMap[skuId];
                        if (!c) return;
                        places.forEach(({ addr }) => {
                            if (!addr) return;
                            if (addr.includes('@')) {
                                counter.USERS += c;
                            } else if (addr === 'GTW_IN_DTW') {
                                counter.GTW_IN_DTW += c;
                            } else if (addr === 'GTW_IN_DA1') {
                                counter.GTW_IN_DA1 += c;
                            } else if (addr === 'GTW_IN_DPK') {
                                counter.GTW_IN_DPK += c;
                            }
                        });
                    });
                    // Define colors for the badges
                    const badgeStyles = {
                        USERS: { text:'#fff', bg:'#95a5a6' },
                        GTW_IN_DTW: { text:'#fff', bg:'#3498db' },
                        GTW_IN_DA1: { text:'#fff', bg:'#9b59b6' },
                        GTW_IN_DPK: { text:'#fff', bg:'#1abc9c' }
                    };
                    // Append badges for each category if count > 0
                    ['USERS','GTW_IN_DTW','GTW_IN_DA1','GTW_IN_DPK'].forEach(key => {
                        const val = counter[key];
                        if (val > 0) {
                            const percent = ((val / przetVal) * 100).toFixed(1);
                            const label = key === 'USERS' ? 'Użytkownicy' : key;
                            const col = badgeStyles[key];
                            summaryInline.appendChild(makeBadge(`${label}: ${val} (${percent}%)`, col.text, col.bg));
                        }
                    });
                    // Calculate and display the number of orders without a replenishment document.  This
                    // summary is based on the waiting-for-replenishment report.  It is appended
                    // only if data is available and there are unmatched SKUs.
                    // Calculate and display the number of orders without a replenishment document.  Use
                    // a promise chain instead of await because this callback is not async.
                    pobierzWaitingData().then(waitingList => {
                        try {
                            if (waitingList && waitingList.length && przetVal > 0) {
                                // Build a set of known SKU IDs from all statuses to determine
                                // which waiting items lack documents.  Use pobierzDane(null) to
                                // include both Gotowy and Przetwarzane statuses.
                                const daneAll = pobierzDane(null);
                                const knownIds = new Set();
                                if (daneAll && daneAll.strefaSkuMap) {
                                    Object.values(daneAll.strefaSkuMap).forEach(skuObjMap => {
                                        Object.values(skuObjMap).forEach(({ id }) => {
                                            if (id) knownIds.add(id);
                                        });
                                    });
                                }
                                const unmatched = waitingList.filter(it => !knownIds.has(it.id));
                                if (unmatched.length) {
                                    const sumOrders = unmatched.reduce((acc,it) => acc + (it.count || 0), 0);
                                    const skuCount = unmatched.length;
                                    summaryInline.appendChild(makeBadge(`Bez dok.: ${sumOrders} (${skuCount} SKU)`, '#fff', '#e74c3c'));
                                }
                            }
                        } catch (err) {
                            console.error('[Wykres Strefy] Błąd przy obliczaniu wskaźnika bez dokumentu:', err);
                        }
                    }).catch(err => {
                        console.error('[Wykres Strefy] Błąd pobierania danych bez dokumentu:', err);
                    });
                }
            } catch (err) {
                console.error('[Wykres Strefy] Nie udało się obliczyć wskaźników adresów:', err);
            }
            topBar.appendChild(summaryInline);

            const canvasContainer=document.createElement("div"); canvasContainer.style="flex:1;position:relative;";
            const canvas=document.createElement("canvas"); canvasContainer.appendChild(canvas);
            chartDiv.appendChild(canvasContainer);
            document.body.appendChild(chartDiv);

            const colors=etykiety.map(s=>przypisania[s]? '#E94E77':'#4A90E2');

            chartInstance=new Chart(canvas,{
                type:'bar',
                data:{labels:etykiety,datasets:[{label:'Suma zamówień (unikalne SKU)',data:wartosci,backgroundColor:colors}]},
                options:{
                    onClick:function(evt,elements){
                        if(!elements.length)return;
                        const strefa=this.data.labels[elements[0].index];
                        przypiszOperatora(strefa);
                    },
                    responsive:true,
                    maintainAspectRatio:false,
                    scales:{x:{ticks:{autoSkip:false}},y:{beginAtZero:true}},
                    plugins:{datalabels:{anchor:'end',align:'end',color:'#000',font:{weight:'bold',size:12},formatter:(value)=>`${value}`}}
                },
                plugins:[ChartDataLabels,'operatorTooltipPlugin']
            });

            // dodanie ikon 🔍 nad słupkami
            const meta = chartInstance.getDatasetMeta(0);
            meta.data.forEach((bar,i)=>{
                const strefa = chartInstance.data.labels[i];
                const skuMap = strefaSkuMap[strefa] || {};
                const div = document.createElement('div');
                div.textContent = '🔍';
                div.style.cssText = `
                    position:absolute;
                    left:${bar.x}px;
                    top:${bar.y-30}px;
                    transform:translate(-50%,0);
                    cursor:pointer;
                    font-size:16px;
                    z-index:1000;
                `;
                div.onclick = ()=>pokazSkuPopup(strefa, skuMap);
                canvasContainer.appendChild(div);
            });

        },400);
    }

    document.addEventListener("keydown",e=>{
        if(e.key==="`"){
            if(chartDiv){
                if(chartInstance) chartInstance.destroy();
                chartDiv.remove();
                chartDiv=null;
                chartInstance=null;
            } else stworzWykres();
        }
    });

})();
