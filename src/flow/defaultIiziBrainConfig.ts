import type { BrainIntentSlug, IiziBrainConfigV1 } from "./iiziBrainConfigTypes.js";
import { IIZI_BRAIN_CONFIG_SCHEMA_VERSION } from "./iiziBrainConfigTypes.js";

const DEFAULT_PRECEDENCE: Exclude<BrainIntentSlug, "unknown">[] = [
  "non_roadside",
  "emergency_handoff",
  "roadside",
];

/**
 * Ships with orchestrator — matches conservative production behavior + broad Eesti roadside cues.
 */
export const DEFAULT_IIZI_BRAIN_CONFIG: IiziBrainConfigV1 = {
  schemaVersion: IIZI_BRAIN_CONFIG_SCHEMA_VERSION,
  matchPrecedenceSlugs: DEFAULT_PRECEDENCE,
  supported_languages: ["et", "en", "ru"],
  intents: {
    non_roadside: {
      required_fields: ["caller_need_classification"],
      ruleGroups: [
        {
          id: "no_need_road_help",
          examples: ["Ei vaja abi", "Mitte teeabi"],
          keywords: [
            "ei vaja abi",
            "pole abi",
            "pole tegemist autoabi",
            "ainult kontor",
            "kontori küsimus",
            "arve küsimus",
            "kindlustuse pakkumine",
            "tellimus küsimus",
            "väär number",
          ],
          patterns: [
            String.raw`\bei\s+vaja\s+(?:auto\s*)?abi\b`,
            String.raw`\bpole\s+(?:auto\s*)?abi\b`,
            String.raw`\bmitte\s+(?:auto\s*)?abi\b`,
            String.raw`\b(sooviks|sooviksin)[^\n]{0,40}\bteada\b`,
            String.raw`\b(helistage\s+)?tagasi\b`,
          ],
        },
        {
          id: "insurance_info_office_inquiry",
          examples: ["Soovin kindlustuse kohta infot", "Kindlustuse kohta infot"],
          keywords: [],
          patterns: [
            /** Narrow: general info about insurance (office line), not live cover/roadside diagnosis. */
            String.raw`(?:\b(?:soovin|sooviksin|tahan)\s+)?\bkindlustuse\s+kohta\s+infot\b`,
          ],
        },
      ],
    },
    emergency_handoff: {
      required_fields: [],
      ruleGroups: [
        {
          id: "explicit_emergency_medical_fire",
          examples: ["Kutsuge kiirabi", "Põleb", "Vigastada"],
          keywords: [
            "112",
            "kiirabi",
            "politsei",
            "pääste",
            "tulekahju",
            "süttis",
            "veri",
            "hingamine",
          ],
          patterns: [],
        },
      ],
    },
    roadside: {
      required_fields: ["roadside_confirmation"],
      ruleGroups: [
        {
          id: "crash_accident",
          examples: ["Mul oli liiklusavari", "Läksin kokku kraavi"],
          keywords: [
            "avari",
            "avarii",
            "õnnetus",
            "crash",
            "krahh",
          ],
          patterns: [],
        },
        {
          id: "fuel_empty",
          examples: ["Mul sai kütus otsa", "Bensiin otsas"],
          keywords: [
            "kütus otsas",
            "bensiin otsas",
            "bentsiin otsas",
          ],
          patterns: [
            String.raw`\b(?:kütus|bensiin|bentsiin)(?:\s+on)?\s+otsas\b`,
            String.raw`\b(?:sai|sain|saime|mul\s+sai)[^\n]{0,24}(?:kütus|bensiin|bentsiin)\s+otsa\b`,
          ],
        },
        {
          id: "stuck_movability",
          examples: ["Auto kinni põllus"],
          keywords: ["auto ei liigu", "ei liigu", "jäin kinni"],
          patterns: [
            String.raw`\b(?:auto\s+)?ei\s+liigu\b`,
            String.raw`\bauto\s+kinni\b`,
          ],
        },
        {
          id: "wont_start",
          keywords: [],
          patterns: [
            String.raw`\b(?:auto\s+)?ei\s+käivitu\b`,
            String.raw`\bei\s+käivitu\b`,
            String.raw`\bei\s+käivi\b`,
            String.raw`\bkäimatuse\b`,
          ],
        },
        {
          id: "flat_tire",
          keywords: ["rehv katki", "rehv lõhki"],
          patterns: [
            String.raw`\btühi\s+rehv\b`,
            String.raw`\brehv\b`,
            String.raw`\bkumm\b`,
          ],
        },
        {
          id: "battery",
          keywords: ["aku tühi"],
          patterns: [],
        },
        {
          id: "generator_alternator_failure",
          examples: ["Generaator ei tööta", "Generator won't charge"],
          keywords: [],
          patterns: [
            String.raw`\b(?:generaator|generator)\s+ei\s+tööta\b`,
            String.raw`\b(?:generaator|generator)\s+ei\s+lae\b`,
          ],
        },
        {
          id: "lockout_keys_inside",
          examples: ["Ei saa autosse sissee", "Võtmed autos", "Ukse lukkus"],
          patterns: [
            String.raw`\bei\s+saa\b[\s\S]{0,44}?\bautos{2,}e\b`,
            String.raw`\bvõtmed\s+autos\b`,
            String.raw`\bvõtmed\b[\s\S]{0,32}?\bautos{2,}e\b`,
            String.raw`\buks\s+(?:lukkus|luks|luku?s)\b`,
          ],
        },
        {
          id: "towing",
          keywords: ["puksiir", "pukseerim"],
          patterns: [String.raw`\bkraav\b`],
        },
        {
          id: "motor_fluid_damage",
          keywords: ["vedelik lekib", "mootor krahh"],
          patterns: [
            String.raw`\bmootor\b`,
            String.raw`\bvedelik\b`,
            String.raw`\bkahjustus\b`,
          ],
        },
        {
          id: "roadside_wheel_chain",
          patterns: [
            String.raw`\bjäin\s+teele\b`,
            String.raw`\bteele\s+jäänud\b`,
            String.raw`\b(?:varu)?ratta(?:d|)\b`,
            String.raw`\bteel\s+abi\b`,
            String.raw`\babi\s*vaja\s+tee\b`,
            String.raw`\bratas(?:tega)?\b`,
          ],
        },
        {
          id: "general_autoabi_need",
          examples: ["Vajan auto abi"],
          keywords: [],
          patterns: [
            String.raw`\bvaja\b[^\n]{0,32}(?:autos*abi\b|auto\s+abi\b)|\bautos*abi\b|\bautos*\s+abi\b`,
          ],
        },
      ],
    },
  },
  gates: {
    send_combined_sms: {
      roadside: true,
      non_roadside: false,
      emergency_handoff: false,
      unknown: false,
      unknown_conflict: false,
    },
    route_human: {
      non_roadside: true,
      emergency_handoff: true,
      roadside: false,
      unknown: false,
      unknown_conflict: true,
    },
    ask_clarification: {
      unknown: true,
      unknown_conflict: true,
    },
    require_vehicle_lookup: {},
    require_location_confirmed: {},
    require_occupant_count_when: {
      keywords: [],
      intentMatches: ["roadside"],
    },
  },
  toolTemplates: {
    combined_registration_location_sms: "Registreerimisnumbri ja asukoha SMS",
    callback_request_sms: "Retrieval of callback number through SMS",
  },
  exceptions: {
    deny_car_roadside_abi_pattern: String.raw`\bei\s+ole\b[^\n]{0,120}(?:\bautos*\s+abi\b|\bautos*abi\b)`,
  },
};
