# Amazon SES DNS records for arcovia.africa

SES identity created in AWS account `arcovia`, region `eu-west-1` / Europe Ireland.

Current SES verification status: `PENDING`.

These CNAME records were added in Shopify-managed DNS for `arcovia.africa` on 2026-07-08.
Public DNS resolves all three records, but AWS SES still showed `Verification pending` immediately after setup.

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

AWS will verify the SES identity after SES refreshes its verification checks.
