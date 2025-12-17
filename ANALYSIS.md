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
