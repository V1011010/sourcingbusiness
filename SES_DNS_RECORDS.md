# Amazon SES DNS records for arcovia.africa

SES identity created in AWS account `arcovia`, region `eu-west-1` / Europe Ireland.

Current SES verification status: `PENDING`.

Add these CNAME records to the authoritative DNS zone for `arcovia.africa`.

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `fpcfra2mnnphsafpnq57t6le72qencpe._domainkey.arcovia.africa` | `fpcfra2mnnphsafpnq57t6le72qencpe.dkim.amazonses.com` |
| CNAME | `6mygfzwiw27yuvdvgmsu4hu5tbq26kgt._domainkey.arcovia.africa` | `6mygfzwiw27yuvdvgmsu4hu5tbq26kgt.dkim.amazonses.com` |
| CNAME | `o55fok5ecymun33medp2ch2lu4kngjek._domainkey.arcovia.africa` | `o55fok5ecymun33medp2ch2lu4kngjek.dkim.amazonses.com` |

Authoritative DNS currently reports:

- `ns-cloud-a1.googledomains.com`
- `ns-cloud-a2.googledomains.com`
- `ns-cloud-a3.googledomains.com`
- `ns-cloud-a4.googledomains.com`

AWS will verify the SES identity after these records propagate.
