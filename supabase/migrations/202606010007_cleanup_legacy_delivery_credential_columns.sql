update public.merchant_delivery_accounts
set api_key = '',
    api_secret = null,
    updated_at = now()
where api_key is not null
   or api_secret is not null;
