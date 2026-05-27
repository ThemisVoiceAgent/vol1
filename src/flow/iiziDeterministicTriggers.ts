/**
 * Multilingual trigger phrase data (ET/EN/RU). Normalized at index-build time in config.
 * Not used in Realtime prompt.
 */

import type { IiziRoadsideCategory } from "./iiziDeterministicTypes.js";

type LangPhrases = { et: readonly string[]; en: readonly string[]; ru: readonly string[] };

export const IIZI_ROADSIDE_TRIGGER_DATA: Record<IiziRoadsideCategory, LangPhrases> = {
  accident: {
    et: [
      "avarii", "õnnetus", "onnetus", "kokkupõrge", "kokkuporge", "sõitsin otsa", "soitsin otsa",
      "sõideti otsa", "soideti otsa", "kraavi", "sõitsin kraavi", "soitsin kraavi", "teelt välja",
      "teelt valja", "auto sai pihta", "mulle sõideti otsa", "mulle soideti otsa",
    ],
    en: [
      "accident", "car accident", "crash", "collision", "i had an accident", "had an accident",
      "i crashed", "crashed", "someone hit me", "i hit someone", "hit another car",
      "went off the road", "drove into a ditch", "car was hit", "got hit",
    ],
    ru: [
      "авария", "дтп", "столкновение", "попал в аварию", "попала в аварию", "произошла авария",
      "меня ударили", "в меня въехали", "я врезался", "я врезалась", "съехал с дороги",
      "съехала с дороги", "машина попала в аварию",
    ],
  },
  no_start: {
    et: [
      "auto ei käivitu", "auto ei kaivitu", "ei käivitu", "ei kaivitu", "käima ei lähe",
      "kaima ei lahe", "auto ei lähe käima", "auto ei lahe kaima", "aku tühi", "aku tyhi",
      "aku on tühi", "aku on tyhi", "starter ei tööta", "starter ei toota", "mootor ei käivitu",
      "mootor ei kaivitu",
    ],
    en: [
      "car won't start", "car wont start", "won't start", "wont start", "car does not start",
      "car doesn't start", "engine won't start", "engine wont start", "engine does not start",
      "battery dead", "dead battery", "battery is dead", "starter not working",
      "starter does not work", "cannot start the car", "can't start the car",
    ],
    ru: [
      "машина не заводится", "авто не заводится", "не заводится", "двигатель не заводится",
      "мотор не заводится", "не могу завести машину", "аккумулятор сел", "сел аккумулятор",
      "мертвый аккумулятор", "аккумулятор разрядился", "стартер не работает",
    ],
  },
  flat_tire: {
    et: [
      "rehv katki", "rehv purunes", "rehv tühi", "rehv tyhi", "kumm katki", "kumm tühi",
      "kumm tyhi", "rehv läks katki", "rehv laks katki", "rehv on puru", "rehviprobleem",
    ],
    en: [
      "flat tire", "flat tyre", "tire flat", "tyre flat", "tire is flat", "tyre is flat",
      "puncture", "tire puncture", "tyre puncture", "tire burst", "tyre burst",
      "broken tire", "broken tyre", "wheel is flat",
    ],
    ru: [
      "спустило колесо", "колесо спущено", "пробило колесо", "прокол колеса", "лопнуло колесо",
      "лопнула шина", "шина спущена", "резина спущена", "проблема с колесом", "колесо пробито",
    ],
  },
  tow_needed: {
    et: [
      "vajan puksiiri", "puksiir", "vaja puksiiri", "pukseerimist", "vajan pukseerimist",
      "auto ei liigu", "sõiduk ei liigu", "soiduk ei liigu", "ei saa edasi sõita",
      "ei saa edasi soita", "vaja ära vedada", "vaja ara vedada",
    ],
    en: [
      "need towing", "need a tow", "tow truck", "need tow truck", "need a tow truck",
      "towing needed", "car won't move", "car wont move", "car does not move",
      "cannot drive further", "can't drive further", "need to be towed", "car needs towing",
    ],
    ru: [
      "нужен эвакуатор", "нужна эвакуация", "эвакуатор", "нужна буксировка", "нужен буксир",
      "машину надо эвакуировать", "машину нужно эвакуировать", "машина не едет",
      "не могу ехать дальше", "нужна помощь эвакуатора",
    ],
  },
  stuck: {
    et: [
      "auto kinni", "auto on kinni", "jäin kinni", "jain kinni", "lumes kinni", "mudas kinni",
      "kraavis kinni", "auto on kraavis", "ei saa välja", "ei saa valja",
    ],
    en: [
      "car is stuck", "stuck", "stuck in snow", "stuck in mud", "stuck in ditch",
      "car is in a ditch", "cannot get out", "can't get out", "vehicle is stuck",
    ],
    ru: [
      "машина застряла", "застрял", "застряла", "застрял в снегу", "застряла в снегу",
      "застрял в грязи", "застряла в грязи", "застрял в канаве", "машина в канаве",
      "не могу выехать",
    ],
  },
  out_of_fuel: {
    et: [
      "kütus otsas", "kutus otsas", "bensiin otsas", "diisel otsas", "paak tühi", "paak tyhi",
      "kütus sai otsa", "kutus sai otsa", "bensiin sai otsa",
    ],
    en: [
      "out of fuel", "out of gas", "out of petrol", "out of diesel", "no fuel", "empty tank",
      "tank is empty", "ran out of petrol", "ran out of diesel", "ran out of fuel",
    ],
    ru: [
      "закончился бензин", "закончился дизель", "нет топлива", "кончилось топливо",
      "закончилось топливо", "пустой бак", "бак пустой", "нет бензина", "нет дизеля",
    ],
  },
  locked_out: {
    et: [
      "võtmed autos", "votmed autos", "võti autos", "voti autos", "võtmed jäid autosse",
      "votmed jaid autosse", "ei saa autosse sisse", "uksed lukus", "auto uksed lukus",
      "võti jäi sisse", "voti jai sisse",
    ],
    en: [
      "keys in car", "keys are in the car", "keys locked in car", "locked out",
      "locked out of the car", "can't get into the car", "cant get into the car",
      "cannot get into the car", "doors are locked", "car is locked",
    ],
    ru: [
      "ключи в машине", "ключ внутри машины", "ключи остались в машине",
      "не могу попасть в машину", "не могу открыть машину", "двери закрыты",
      "машина закрыта", "машина заблокирована", "ключи внутри",
    ],
  },
  mechanical_issue: {
    et: [
      "generaator katki", "generaator on katki", "generaator ei tööta", "generaator ei toota",
      "genekas katki", "genekas ei tööta", "genekas ei toota", "õli lekib", "oli lekib",
      "õlileke", "olileke", "õli jookseb", "oli jookseb", "jahutusvedelik lekib", "tosool lekib",
      "vedelik lekib", "kütus lekib", "kutus lekib", "mootor kuumeneb", "mootor läheb kuumaks",
      "mootor laheb kuumaks", "mootor üle kuumenenud", "mootor ule kuumenenud",
      "mootor teeb imelikku häält", "mootor teeb imelikku haalt", "mootor koliseb",
      "mootor lonkab", "mootor seiskus", "mootor suri välja", "mootor suri valja",
      "auto suri välja", "auto suri valja", "auto läks katki", "auto laks katki", "auto on katki",
      "autol on rike", "tehniline rike", "elektroonika rike", "elektri rike",
      "armatuuris põleb tuli", "armatuuris poleb tuli", "mootorituli põleb", "mootorituli poleb",
      "kontrolltuli põleb", "kontrolltuli poleb", "aku tuli põleb", "aku tuli poleb",
      "laadimise tuli põleb", "laadimise tuli poleb", "pidurid ei tööta", "pidurid ei toota",
      "piduritega probleem", "sidur katki", "sidur ei tööta", "sidur ei toota",
      "käigukast katki", "kaigukast katki", "käigukastiga probleem", "kaigukastiga probleem",
      "rool ei tööta", "rool ei toota", "rool raske", "rihm katki", "hammasrihm katki",
      "ventilaator ei tööta", "ventilaator ei toota", "auto suitseb", "kapoti alt tuleb suitsu",
      "salongi tuleb suitsu", "imelik lõhn", "imelik lohn", "põlemise lõhn", "polemise lohn",
      "bensiini lõhn", "bensiini lohn", "diisli lõhn", "diisli lohn",
      "klaasipuhastid ei tööta", "klaasipuhastid ei toota", "tuled ei tööta", "tuled ei toota",
      "esituled ei tööta", "esituled ei toota", "tagatuled ei tööta", "tagatuled ei toota",
      "uks ei avane", "uks ei lähe kinni", "uks ei lahe kinni", "kapott ei avane", "pagasiluuk ei avane",
    ],
    en: [
      "alternator is broken", "alternator broken", "alternator not working", "oil is leaking",
      "oil leak", "leaking oil", "coolant is leaking", "coolant leak", "fluid is leaking",
      "fuel is leaking", "engine is overheating", "engine overheated", "engine is too hot",
      "engine makes a strange noise", "engine noise", "engine knocking", "engine stopped",
      "engine died", "car died", "car broke down", "car is broken", "technical fault",
      "mechanical fault", "electrical fault", "electronics fault", "warning light is on",
      "engine light is on", "check engine light is on", "battery light is on", "charging light is on",
      "brakes are not working", "brake problem", "clutch is broken", "clutch not working",
      "gearbox problem", "transmission problem", "steering problem", "steering is heavy",
      "belt snapped", "belt broken", "fan not working", "car is smoking", "smoke from engine",
      "smoke under the hood", "smoke in the cabin", "strange smell", "burning smell",
      "smell of fuel", "petrol smell", "diesel smell", "wipers not working", "lights not working",
      "headlights not working", "rear lights not working", "door will not open", "door will not close",
      "hood will not open", "trunk will not open", "boot will not open",
    ],
    ru: [
      "генератор сломан", "генератор не работает", "проблема с генератором", "течет масло",
      "утечка масла", "масло вытекает", "течет охлаждающая жидкость",
      "утечка охлаждающей жидкости", "течет тосол", "течет жидкость", "течет топливо",
      "утечка топлива", "двигатель перегревается", "двигатель перегрелся", "мотор перегревается",
      "мотор перегрелся", "двигатель слишком горячий", "двигатель издает странный звук",
      "странный звук двигателя", "двигатель стучит", "мотор стучит", "двигатель заглох",
      "мотор заглох", "машина заглохла", "машина сломалась", "автомобиль сломался",
      "машина неисправна", "техническая неисправность", "механическая неисправность",
      "электрическая неисправность", "проблема с электрикой", "горит лампочка на панели",
      "горит чек", "горит check engine", "горит индикатор двигателя", "горит лампа аккумулятора",
      "горит лампа зарядки", "тормоза не работают", "проблема с тормозами",
      "сцепление сломалось", "сцепление не работает", "проблема с коробкой передач",
      "коробка передач сломалась", "проблема с рулем", "руль тяжелый", "порвался ремень",
      "ремень порвался", "вентилятор не работает", "машина дымит", "дым из двигателя",
      "дым из-под капота", "дым в салоне", "странный запах", "запах гари", "запах бензина",
      "запах дизеля", "дворники не работают", "фары не работают", "свет не работает",
      "задние фонари не работают", "дверь не открывается", "дверь не закрывается",
      "капот не открывается", "багажник не открывается",
    ],
  },
  generic_roadside: {
    et: [
      "autoabi", "vajan autoabi", "abi autoga", "autoga probleem", "auto läks katki",
      "auto laks katki", "auto probleem", "sõidukiga probleem", "soidukiga probleem",
      "tee peal hädas", "tee peal hadas",
    ],
    en: [
      "roadside assistance", "need roadside assistance", "need roadside help", "need car help",
      "car help", "car problem", "vehicle problem", "car broke down", "breakdown",
      "stuck on the road", "need help with my car",
    ],
    ru: [
      "нужна помощь на дороге", "нужна дорожная помощь", "нужна авто помощь",
      "нужна помощь с машиной", "проблема с машиной", "проблема с автомобилем",
      "машина сломалась", "поломка", "сломалась машина", "нужна помощь",
    ],
  },
};

export const IIZI_NON_ROADSIDE_TRIGGER_DATA: LangPhrases = {
  et: [
    "kindlustus", "poliis", "poliisi küsimus", "poliisi kysimus", "arve", "arve kohta",
    "pakkumine", "tahan pakkumist", "kahjujuhtum", "kahju küsimus", "kahju kysimus",
    "lepingu muutmine", "roheline kaart", "maksegraafik", "poliisi lõpetamine",
    "poliisi lopetamine", "makse", "maksmine", "kindlustuse hind",
  ],
  en: [
    "insurance", "insurance question", "policy", "insurance policy", "policy question", "invoice", "bill", "billing",
    "quote", "insurance quote", "i want a quote", "claim", "insurance claim", "change my policy",
    "green card", "payment schedule", "cancel policy", "cancel insurance", "payment",
    "price of insurance",
  ],
  ru: [
    "страховка", "страховой полис", "вопрос по страховке", "вопрос по полису", "счет", "счёт",
    "оплата", "платеж", "предложение", "хочу предложение", "страховое предложение",
    "страховой случай", "заявление о страховом случае", "изменить полис", "зеленая карта",
    "зелёная карта", "график платежей", "отменить полис", "расторгнуть полис", "цена страховки",
  ],
};

/** Unsafe — excludes bare "smoke"/"suits" (mechanical unless fire/danger context). */
export const IIZI_UNSAFE_TRIGGER_DATA: LangPhrases = {
  et: [
    "keegi sai viga", "vigastatud", "inimene sai viga", "laps sai viga", "kiirabi", "tuli",
    "põleb", "poleb", "tugev suits", "ohtlik", "tee on kinni", "liiklus on kinni",
    "blokeerib liiklust", "inimene on autos kinni", "pidurid kadusid",
    "pidurid ei tööta sõidu ajal", "pidurid ei toota soidu ajal", "ei saa pidama",
    "salongi tuleb suitsu", "kapoti alt tuleb suitsu ja põleb",
  ],
  en: [
    "someone is injured", "injured", "person is injured", "child is injured", "ambulance", "fire",
    "car is burning", "burning", "heavy smoke", "dangerous", "road is blocked", "blocking traffic",
    "traffic is blocked", "person trapped in car", "trapped inside", "brakes failed",
    "brakes failed while driving", "cannot stop", "can't stop", "smoke in the cabin",
  ],
  ru: [
    "кто-то пострадал", "есть пострадавшие", "человек пострадал", "ребенок пострадал",
    "ребёнок пострадал", "травма", "скорая", "пожар", "машина горит", "горит", "сильный дым",
    "опасно", "дорога заблокирована", "перекрывает движение", "блокирует движение",
    "человек застрял в машине", "человек внутри", "отказали тормоза", "тормоза отказали",
    "не могу остановиться", "дым в салоне",
  ],
};

export const IIZI_PASSENGER_TRIGGER_DATA: LangPhrases = {
  et: [
    "olen tüdrukuga", "olen tydrukuga", "olen naisega", "olen mehega", "olen sõbraga",
    "olen sobraga", "olen lapsega", "kaasreisija", "reisija", "kahekesi", "meid on kaks",
    "autos on kaks",
  ],
  en: [
    "girlfriend is with me", "wife is with me", "husband is with me", "boyfriend is with me",
    "friend is with me", "child is with me", "passenger", "two of us", "we are two",
    "there are two of us", "someone is with me",
  ],
  ru: [
    "я с девушкой", "я с женой", "я с мужем", "я с другом", "я с ребенком", "я с ребёнком",
    "пассажир", "мы вдвоем", "мы вдвоём", "нас двое", "в машине двое", "со мной человек",
  ],
};

/** Vehicle cannot move / stranded (occupant gate for mechanical). */
export const IIZI_STRANDED_MOVE_PHRASES: readonly string[] = [
  "auto ei liigu", "ei saa edasi soita", "car wont move", "cannot drive further",
  "car won't move", "машина не едет", "не могу ехать дальше", "vajan puksiiri", "need a tow",
  "нужен эвакуатор", "stuck", "kinni", "застрял",
];

/** Fuzzy ASR variants (normalized). */
export const IIZI_FUZZY_EXTRA: readonly { phrase: string; category: IiziRoadsideCategory }[] = [
  { phrase: "avarii", category: "accident" },
  { phrase: "avrii", category: "accident" },
  { phrase: "avari", category: "accident" },
  { phrase: "rehv katki", category: "flat_tire" },
  { phrase: "reff katki", category: "flat_tire" },
  { phrase: "rehv gatki", category: "flat_tire" },
  { phrase: "auto ei kaivitu", category: "no_start" },
  { phrase: "aku tyhi", category: "no_start" },
  { phrase: "puksiir", category: "tow_needed" },
  { phrase: "oli lekib", category: "mechanical_issue" },
  { phrase: "oil leak", category: "mechanical_issue" },
];

export const IIZI_EN_LANG_HINTS: readonly string[] = [
  "accident", "insurance", "tow", "flat tire", "won't", "wont", "car won't", "need help",
  "broken", "leaking", "someone is", "i had", "my car",
];

export const IIZI_ET_LANG_HINTS: readonly string[] = [
  "avarii", "autoabi", "ei käivitu", "rehv", "kindlustus", "mul on", "vajan",
];

export const IIZI_RU_LANG_HINTS: readonly string[] = [
  "машина", "нужен", "авария", "страхов", "эвакуатор", "не заводится",
];
