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
2. **Profil.** Przy pierwszej wizycie utwórz profil: imię, waga, wzrost, avatar i strój (własne kolory albo **strój klubowy UECT**), nakrycie głowy, kolor ramy, skóra i włosy. Podgląd 3D zmienia się na żywo. Na jednym komputerze może być kilka profili. Przy kolejnej wizycie wybierasz swój, tworzysz nowy albo edytujesz (✏️). Profile zapisują się w przeglądarce.
3. **Kto jest na trasie.** Widzisz wszystkie aktywne przejazdy i kto w nich jedzie. Do wyboru:
   - **Dołącz do X**: pojawiasz się tuż za wybraną osobą,
   - **Jedź od startu**,
   - **Dołącz do eventu**, jeśli gospodarz zaplanował jazdę grupową (widać licznik do startu),
   - **➕ Nowy przejazd**: własny kod i trasa.
4. W grze **🔗 Zaproś** kopiuje link do przejazdu. Kto go otworzy, od razu widzi ten przejazd na górze listy.
5. **🔌 Trener** łączy z trenerem, **❤️ Puls** z paskiem HR, **🎙️ Rozmowa** włącza głos (klawisz `M` wycisza mikrofon).
6. **👕 Strój** pozwala zmienić wygląd w trakcie jazdy. Inni widzą zmianę od razu.
7. **↪** przy kolarzu na liście grupy przenosi Cię do niego, a **⏮ Na start** na początek trasy.
8. **Jazda grupowa.** Gospodarz (pierwsza osoba w przejeździe) wybiera czas, np. „za 5 min”, i klika **📅 Zaplanuj**. Każdy widzi pasek z odliczaniem i przycisk **Dołącz do eventu**. Zapisani czekają na starcie i ruszają razem po odliczaniu.
9. **🏁 Zakończ** pokazuje podsumowanie: dystans, czas, moc, W/kg, przewyższenie i tętno. Możesz:
   - **zapisać jazdę w historii** (menu → „Moje przejazdy”),
   - **pobrać GPX** (Strava),
   - **pobrać TCX** (Strava i Garmin Connect, z mocą, tętnem i kadencją).

   Po wgraniu ustaw typ aktywności na „Jazda wirtualna”. Jeśli karta się zamknie w trakcie jazdy, przejazd zostanie odzyskany jako szkic przy następnym wejściu.

Skróty klawiszowe: `↑`/`↓` zmieniają moc ręczną, `M` wycisza mikrofon, `Enter` otwiera czat, `C` zmienia widok kamery.

**Kamera:** przeciągnij myszą, żeby obrócić kamerę wokół kolarza. Kółko przybliża i oddala (aż do widoku z góry), dwuklik wraca do ustawień domyślnych. Dostępne widoki: za kolarzem, z bliska, z boku, z przodu, dron, z góry (mapa) i pierwsza osoba.

**🧪 Tryb testowy** pozwala sprawdzić trasę bez trenera: moc wirtualna (suwak lub strzałki), przyspieszenie czasu ×2/×5/×20, skok do wybranego kilometra, test sprintu i wybór kamery. W tym trybie jazda nie jest nagrywana.

**Hiper focus.** W profilu podajesz FTP i próg (domyślnie 3 × FTP). Gdy średnia moc z 3 s przekroczy próg, kamera wchodzi w tryb sprintu: obraz rozmywa się promieniście jak przy „warp speed”, krawędzie ciemnieją, lecą smugi światła, a interfejs przygasa. Zostaje tylko świecący punkt na drodze przed Tobą. Efekt wyłącza się, gdy moc spadnie poniżej 85% progu. Kolor liczby mocy pokazuje strefę względem FTP.

Gra liczy jazdę także wtedy, gdy karta jest w tle, ale najlepiej trzymać ją na pierwszym planie.

## Teren i grafika

Teren 3D buduje się z prawdziwych danych dla okolicy trasy:

- **Wysokość w Walii: lidar 1 m.** Numeryczny model terenu Welsh Government / Natural Resources Wales (Open Government Licence v3.0), jeden plik COG dla całej Walii. Serwer czyta z niego tylko fragmenty wokół kolarza (zapytania HTTP o zakres bajtów) i przelicza je na kafle mapy.
- **Wysokość poza Walią** (albo gdy lidar jest niedostępny): [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen, AWS Open Data), rozdzielczość ok. 30 m.
- **Wygląd terenu:** zdjęcia satelitarne [Sentinel-2 cloudless](https://s2maps.eu) od EOX, na licencji CC BY-NC-SA 4.0, czyli tylko do użytku niekomercyjnego (klubowy użytek jest OK). Drzewa stoją tam, gdzie zdjęcia pokazują las.
- **Dopasowanie do drogi:** droga zachowuje wysokość z pliku GPX, a teren jest do niej wyrównywany. Liczona jest różnica między GPX a mapą wysokości wzdłuż trasy.
- **Plan bliski i daleki:** szczegółowy teren ok. 3 km wokół kolarza i daleki plan do ok. 20 km (góry na horyzoncie).

Kafle pobiera serwer aplikacji (`/tiles/...`) i zapisuje je w pamięci podręcznej na dysku. Przeglądarki graczy nie łączą się z zewnętrznymi serwisami. Jeśli danych nie da się pobrać, gra pokazuje teren zastępczy, czyli wygenerowane pagórki.

Zmienne środowiskowe (opcjonalne):

| Zmienna | Znaczenie |
|---|---|
| `LIDAR_COG_URL` | Plik lidarowy COG w układzie EPSG:27700 (domyślnie walijski DTM 1 m; pusta wartość wyłącza lidar) |
| `ELEV_TILES_URL` | Inne źródło kafli wysokości w formacie Terrarium (`{z}/{x}/{y}`) |
| `SAT_TILES_URL` | Inne źródło zdjęć satelitarnych (`{z}/{x}/{y}`) |
| `TILE_CACHE_DIR` | Katalog pamięci podręcznej kafli (domyślnie katalog tymczasowy) |
| `TILE_MOCK=1` | Teren testowy bez internetu (do pracy lokalnej) |

### Google Photorealistic 3D Tiles (opcjonalnie)

Przycisk **🗺️ Teren** w grze przełącza między własnym terenem (lidar + zdjęcia satelitarne) a fotorealistycznym modelem 3D od Google. Do tego potrzebny jest klucz Google Map Tiles API:

1. W Google Cloud Console utwórz projekt, dodaj konto rozliczeniowe i włącz **Map Tiles API**.
2. Utwórz klucz API. W ograniczeniach ustaw: API → tylko Map Tiles API; Websites → `http://localhost:3000/*` oraz adres gry na Renderze, np. `https://twoja-gra.onrender.com/*`.
3. Ustaw w Quotas limit „3D Tiles root requests per day” (np. 300) oraz budżet z alertem.
4. Ustaw zmienną środowiskową `GOOGLE_MAPS_KEY`: lokalnie w PowerShell `$env:GOOGLE_MAPS_KEY="..."` przed `npm start`, a na Renderze w zakładce Environment.

Klucz trafia do przeglądarki graczy, bo Google wymaga zapytań wprost z przeglądarki. Dlatego ograniczenie do adresów strony jest konieczne. Gra przesuwa układ współrzędnych za kolarzem (krzywizna Ziemi) i sama dopasowuje wysokość modelu Google do drogi. Jeśli kafle się nie wczytają, gra wraca do własnego terenu.

### Dopasowanie trasy do dróg (OpenStreetMap)

GPS z zegarka bywa przesunięty o kilka metrów względem drogi. W Google 3D wyglądało to tak, jakby jechało się poboczem albo przez murek. Przy pierwszym uruchomieniu serwer pobiera z OpenStreetMap (Overpass API) drogi wzdłuż trasy, zapisuje je w `routes/<trasa>.roads.json` i przesuwa każdy punkt trasy na oś najbliższej drogi biegnącej w tym samym kierunku. Warto dodać ten plik do repozytorium (`git add routes/*.roads.json`), żeby Render nie pobierał dróg przy każdym wdrożeniu. Wyłączenie: `OSM_SNAP=0`.

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
| `server.js` | Express + Socket.IO: trasy, lista aktywnych przejazdów, grupy, jazdy grupowe, czat, sygnalizacja WebRTC |
| `lib/gpx.js` | Parsowanie GPX, wygładzanie wysokości i nachylenia, przeliczanie na metry |
| `public/js/world.js` | Świat 3D (Three.js): droga, teren generowany wokół kolarza, drzewa, kolarze, kamera |
| `public/js/physics.js` | Fizyka: moc → prędkość (opór powietrza, toczenia, grawitacja, drafting) |
| `public/js/trainer.js` | Web Bluetooth: FTMS (odczyt i sterowanie nachyleniem), Cycling Power, Heart Rate |
| `public/js/voice.js` | Rozmowy głosowe WebRTC i wskaźnik mówienia |
| `public/js/hud.js` | Profil wysokości i minimapa |
| `public/js/profile.js` | Profile kolarzy w przeglądarce, edytor wyglądu |
| `public/js/kits.js` | Stroje klubowe (tekstury UECT, grafiki w `public/kits/`) |
| `public/js/recorder.js` | Zapis jazdy, historia, eksport GPX/TCX |
| `public/js/ride.js` | Logika jazdy: teleporty, eventy, garderoba, podsumowanie |
| `public/js/rider.js` | Rower i kolarz (nogi na pedałach liczone na bieżąco) |
| `public/js/terrain.js` | Teren z danych wysokościowych i zdjęć satelitarnych, drzewa |
| `public/js/camera.js` | Kamera: widoki, obrót myszą, zoom |
| `public/js/warp.js` | Efekt hiper focus (post-processing, smugi, punkt skupienia) |
| `lib/osm.js` | Dopasowanie trasy GPS do dróg z OpenStreetMap |
| `public/js/google3d.js` | Google Photorealistic 3D Tiles (3DTilesRendererJS) w układzie gry |
| `lib/tiles.js` | Pobieranie kafli map przez serwer, z pamięcią podręczną |
| `lib/lidar.js`, `lib/bng.js` | Kafle wysokości z lidaru (COG) i przeliczanie GPS → brytyjski układ współrzędnych |

Prędkość w grze wynika z mocy z trenera i nachylenia trasy, tak jak w Zwifcie. Prędkość podawana przez sam trener jest ignorowana.
