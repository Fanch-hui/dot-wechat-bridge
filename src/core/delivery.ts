export function delivery(job:{id:string;state:string;error_code:string|null;error_message:string|null}) {
  const labels:Record<string,string>={ready:'等待发送',sending:'正在发送',delivered:'已发送',
    failed:'发送失败',unknown:'发送结果未知',cancelled:'已跳过'};
  return {reply_id:job.id,status:job.state,
    status_text:job.state==='unknown' && job.error_code==='send_timeout'?'发送超时':labels[job.state]??job.state,
    ...(job.error_message?{error_message:job.error_message}:{}),
    ...(job.error_code?{error_code:job.error_code}:{}),
    ...(job.state==='unknown'?{retry_requires_confirmation:true}:{}),
  };
}
