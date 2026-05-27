export interface IntraCampaignClient {
  fk_task_id?: string;
  name?: string;
  deptor_phone?: string;
  debtor_phone?: string;
  claim_remain?: string;
  last_income_date?: string;
  dept_source?: string;
  creditor_name?: string;
  checked_for_robot_call?: boolean;
  case_name?: string;
}

export interface StartCampaignRequestBody {
  selectedVoice?: string;
  callback_url?: string;
  clients?: IntraCampaignClient[];
}

export interface LegacyStatisticsRow {
  campaign_id: number;
  fk_task_id: string;
  client_id: string;
  client_name: string;
  phone: string;
  phone_number: string;
  debt_amount: string;
  call_sid: string;
  number_call_made_from: string;
  call_date: string;
  call_pickup_date: string | null;
  call_length: string;
  call_count: number;
  call_status: string;
  call_result: string;
  call_summary: string;
  transcript: string;
  recording_url: string;
}
