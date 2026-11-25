# 🚴 GPX Ride

Jazda po własnej trasie GPX w 3D, trochę jak w Zwifcie, razem ze znajomymi z klubu i z rozmową głosową.

- **Świat 3D** zbudowany z pliku GPX: droga, teren, drzewa, profil wysokości, minimapa
- **Smart trener** przez Bluetooth (FTMS: Wahoo, Tacx, Elite, Saris, JetBlack…). Trener sam zwiększa opór na podjazdach, a suwak *Trudność trenera* działa jak w Zwifcie
- **Miernik mocy / pulsometr** przez Bluetooth (Cycling Power, Heart Rate)
- **Wspólna jazda**: wspólny kod przejazdu, link zaproszenia, lista grupy z odstępami i W/kg, jazda w tunelu powietrznym (drafting), wspólny start z odliczaniem, czat
- **Rozmowy głosowe** w przeglądarce (WebRTC, bez instalowania czegokolwiek)
- Bez trenera możesz jechać suwakiem mocy albo strzałkami ↑ ↓, co przydaje się do testów

## Jak jeździć

1. Otwórz stronę w **Chrome lub Edge** na komputerze (Windows / macOS) albo w Chrome na Androidzie. Safari i iPhone nie obsługują Web Bluetooth.
2. Wpisz imię, wagę i kod przejazdu (np. `wtorek-klub`), a potem kliknij **Jedziemy!**
3. Kliknij **🔗 Kopiuj link zaproszenia** i wyślij go znajomym. Kto wejdzie z tym linkiem, jedzie w tej samej grupie i na tej samej trasie.
4. **🔌 Trener** łączy z trenerem, a **❤️ Pulsometr** z paskiem HR.
5. **🎙️ Dołącz do rozmowy** włącza głos. Klawisz `M` wycisza i włącza mikrofon. Najlepiej jechać w słuchawkach.
6. Pierwsza osoba w grupie (gospodarz) może kliknąć **🏁 Start wspólny**: wszyscy wracają na start i ruszają razem po 10-sekundowym odliczaniu.

Skróty klawiszowe: `↑`/`↓` zmieniają moc ręczną, `M` wycisza mikrofon, `Enter` otwiera czat.

## Dodawanie tras

Wrzuć plik `.gpx` do folderu `routes/`, zrób commit i push. Render sam przebuduje aplikację, a trasa pojawi się na liście. Obsługiwane są ślady (`trkpt`) i trasy (`rtept`) z wysokością. Trasa, której koniec leży blisko startu, jest traktowana jak pętla i można ją jechać wiele okrążeń.

Wskazówka: pliki eksportowane z aktywności Strava/Garmin zawierają tętno, kadencję i czas. Do repo wystarczą same współrzędne i wysokość.

## Uruchomienie lokalne

```bash
npm install
npm start
# http://localhost:3000
```

Web Bluetooth i mikrofon działają tylko przez HTTPS albo na `localhost`.

## Wdrożenie na Render

1. Na [render.com](https://render.com) wybierz **New → Blueprint** i wskaż to repozytorium. Render odczyta plik `render.yaml`.
2. Pola `TURN_*` możesz zostawić puste i kliknąć **Apply**.
3. Po kilku minutach aplikacja jest dostępna pod adresem `https://gpx-ride-xxxx.onrender.com`.

Darmowy plan Render usypia aplikację po ok. 15 minutach bez ruchu, a pierwsze wejście potem trwa do ok. minuty. Przed klubowym przejazdem warto otworzyć stronę wcześniej. Przy regularnej jeździe lepiej sprawdzi się płatny plan *Starter*, który nie usypia aplikacji.

### Głos a sieci firmowe / mobilne (TURN)

Głos łączy się bezpośrednio między uczestnikami (peer-to-peer). W większości domowych sieci działa to od razu. Jeśli ktoś siedzi za restrykcyjną siecią (firmowa, część sieci komórkowych), może być potrzebny serwer TURN. Załóż darmowe konto np. w [Metered](https://www.metered.ca/stun-turn) lub w Cloudflare Calls TURN i w ustawieniach Render ustaw zmienne:

```
TURN_URL=turn:adres:3478,turns:adres:443
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Rozmowa jest w układzie „każdy z każdym”, więc sprawdza się dobrze do ok. 8–10 osób z włączonym mikrofonem. Jechać może więcej osób (domyślnie maks. 20 w grupie, zmienna `MAX_RIDERS`).

## Jak to działa

| Plik | Co robi |
|---|---|
| `server.js` | Express + Socket.IO: lista tras, grupy, synchronizacja pozycji, czat, sygnalizacja WebRTC |
| `lib/gpx.js` | Parsowanie GPX, wygładzanie wysokości i nachylenia, przeliczanie na metry |
| `public/js/world.js` | Świat 3D (Three.js): droga, teren generowany wokół kolarza, drzewa, kolarze, kamera |
| `public/js/physics.js` | Fizyka: moc → prędkość (opór powietrza, toczenia, grawitacja, drafting) |
| `public/js/trainer.js` | Web Bluetooth: FTMS (odczyt i sterowanie nachyleniem), Cycling Power, Heart Rate |
| `public/js/voice.js` | Rozmowy głosowe WebRTC i wskaźnik mówienia |
| `public/js/hud.js` | Profil wysokości i minimapa |

Prędkość w grze wynika z mocy z trenera i nachylenia trasy, tak jak w Zwifcie. Prędkość podawana przez sam trener jest ignorowana.
