# Amazon SES DNS records for arcovia.africa

SES identity created in AWS account `arcovia`, region `eu-west-1` / Europe Ireland.

Current SES verification status: `VERIFIED`.
Current SES production access status: `APPROVED` / production access granted.

These CNAME records were added in Shopify-managed DNS for `arcovia.africa` on 2026-07-08.
Public DNS resolves all three records and AWS SES has verified the domain identity.
The SES production access request was submitted on 2026-07-08. The user reported AWS approval on 2026-07-10.

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `fpcfra2mnnphsafpnq57t6le72qencpe._domainkey.arcovia.africa` | `fpcfra2mnnphsafpnq57t6le72qencpe.dkim.amazonses.com` |
| CNAME | `6mygfzwiw27yuvdvgmsu4hu5tbq26kgt._domainkey.arcovia.africa` | `6mygfzwiw27yuvdvgmsu4hu5tbq26kgt.dkim.amazonses.com` |
| CNAME | `o55fok5ecymun33medp2ch2lu4kngjek._domainkey.arcovia.africa` | `o55fok5ecymun33medp2ch2lu4kngjek.dkim.amazonses.com` |

Authoritative DNS currently reports Shopify/Google-hosted nameservers:

- `ns-cloud-a1.googledomains.com`
- `ns-cloud-a2.googledomains.com`
- `ns-cloud-a3.googledomains.com`
- `ns-cloud-a4.googledomains.com`

After approval, create SES SMTP credentials and add them to Render as `SMTP_USER` and `SMTP_PASSWORD`, with `EMAIL_PROVIDER=smtp`, before relying on live customer email traffic.
