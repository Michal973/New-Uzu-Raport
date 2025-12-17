# Code Analysis

This repository contains a single user script designed for the Gemini WMS web application. The script enhances replenishment reporting by:

- Scraping interactive report tables on several pages to aggregate SKU order counts by zone and status.
- Persisting parsed data for current placements (JT) and waiting-for-replenishment reports in `localStorage` with expiry handling to work around `X-Frame-Options` restrictions.
- Providing UI helpers such as chart generation (Chart.js), CSV export, operator assignments per zone, JT aggregation popups, and unmatched SKU popups with clipboard copying.
- Auto-refreshing cached data by opening hidden tabs when visiting the main `replenishments1` report, ensuring data remains valid across sessions.

The primary script file is `Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js`, which encapsulates all logic within an IIFE and relies on the page DOM along with `localStorage` for state persistence.

## Dlaczego "Odśwież dane" czasami nie działa

Poniżej zestawiono najczęstsze powody, dla których kliknięcie przycisku „Odśwież dane” nie pobiera nowych rekordów z raportów:

- **Blokada wyskakujących okien** – odświeżanie otwiera ukrytą kartę (`window.open`) z raportem i parsuje ją w tle. Jeśli przeglądarka lub rozszerzenie blokuje pop‑upy, `openAndParse` zwraca `null`, więc `refreshJTData`/`refreshWaitingData` kończą się bez zapisu danych.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L282-L304】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L344-L387】
- **Brak aktywnej sesji APEX** – adresy raportów są budowane z parametrem `session`. Gdy aktualny adres URL nie zawiera ważnego `session=<id>`, wywołania korzystają z bazowego linku bez sesji i mogą zostać przekierowane na stronę logowania, co daje puste wyniki po parsowaniu.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L23-L34】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L344-L400】
- **Raport ładuje się zbyt wolno lub ma inne nagłówki** – parser czeka do 1 minuty na pojawienie się nagłówków i wierszy tabeli; po przekroczeniu limitu zwraca `null`. Nawet gdy strona się wczyta, brak oczekiwanych kolumn (np. inne nazwy nagłówków) powoduje zwrócenie pustej struktury, więc w `localStorage` nie lądują żadne dane.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU ID-0.0 (2).user.js†L305-L323】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU ID-0.0 (2).user.js†L351-L369】
- **Dane wygasły w trakcie odświeżania** – po zapisaniu wyniki są oznaczane 5‑minutową datą ważności i dodatkowo czyszczone przez timery. Jeżeli odświeżanie nie uda się (np. z powodu blokady okna), a jednocześnie stare dane zostaną skasowane, wykres po kliknięciu przycisku pozostaje pusty.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU ID-0.0 (2).user.js†L371-L380】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU ID-0.0 (2).user.js†L395-L420】
- **Brak nowych rekordów mimo kliknięcia** – jeśli ręczne odświeżenie zwróci 0 wyników z obu raportów, skrypt wyświetla dodatkowy komunikat z podpowiedziami: odblokuj pop‑up, ewentualnie otwórz raporty w nowej karcie (linki są podane w alercie) i zignoruj komunikat typu „Banner not shown...” pochodzący z PWA, który nie blokuje pobierania danych.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L457-L470】

## Dlaczego w konsoli raz jest waiting=0, a innym razem waiting=188

Komunikaty z konsoli typu `[Wykres Strefy] Odświeżono dane: JT=149, waiting=0` oraz `[Wykres Strefy] Odświeżono dane: JT=149, waiting=188` wynikają z różnicy w dostępności i ważności danych waiting:

- **Czasowa utrata danych waiting** – dane „waiting-for-replenishment” są przechowywane w `localStorage` tylko 5 minut i są automatycznie kasowane po przekroczeniu tego czasu. Jeżeli w tym samym momencie pobieranie z ukrytej karty się nie powiedzie (np. pop‑up został zablokowany), log pokaże `waiting=0`, mimo że przed upływem ważności były wpisy.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L371-L380】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L395-L420】
- **Ręczne odświeżenie rozwiązuje problem** – gdy użytkownik kliknie „Odśwież dane” i pop‑up nie jest blokowany, `openAndParse` pobierze raport, zapisze go w `localStorage` i log pokaże faktyczną liczbę rekordów, np. `waiting=188`. Ten sam kod ustawia nową datę ważności na 5 minut, więc kolejne odczyty będą poprawne, dopóki dane nie wygasną albo kolejne otwarcie karty znów nie zostanie zablokowane.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L344-L387】【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L395-L420】
- **Brak nowych wyników po czasie** – jeżeli raport faktycznie zwróci zero wierszy (np. brak oczekujących uzupełnień), log pokaże `waiting=0` mimo poprawnego działania. W takim przypadku pojawia się także alert z linkami do raportów i wskazówką, że komunikat PWA „Banner not shown...” nie wpływa na pobieranie danych.【F:Wykres Strefy -- Zamówienia SKU + Status + Operatorzy + Popup SKU + Kopiowanie SKU ID-0.0 (2).user.js†L457-L470】
