export const EVENT_NAME="wechat.message.available";
export const eventDefinition={
  name:EVENT_NAME,
  description:"微信成员有待处理消息；每条事件携带可信成员身份和独立会话。",
  delivery:["webhook"],
  inputSchema:{type:"object",properties:{conversation:{type:"string",enum:["personal","all"]}},
    required:["conversation"],additionalProperties:false},
  payloadSchema:{type:"object",properties:{
    participant_id:{type:"string"},display_name:{type:"string"},
    session_id:{type:"string"},pending_count:{type:"integer"},first_sequence:{type:"integer"},
    last_sequence:{type:"integer"},attempt:{type:"integer"},
  },required:["participant_id","display_name","session_id","pending_count","first_sequence","last_sequence","attempt"],additionalProperties:false},
};
