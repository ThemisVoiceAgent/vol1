export type IiziLanguage = "et" | "en" | "ru";

export type IiziRoadsideCategory =
  | "accident"
  | "no_start"
  | "flat_tire"
  | "tow_needed"
  | "stuck"
  | "out_of_fuel"
  | "locked_out"
  | "mechanical_issue"
  | "generic_roadside";

export type IiziIncidentType = IiziRoadsideCategory;

export type IiziCanonicalCategory =
  | IiziRoadsideCategory
  | "not_roadside_assistance"
  | "unsafe_volunteered";
