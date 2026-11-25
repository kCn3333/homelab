# LinkVortex

**Platform:** :simple-hackthebox: Hack The Box 
**OS:** Linux 
**Lab date:** 2025-03-09

## Virtual host discovery

Virtual-host enumeration identified the development subdomain. A separate endpoint enumeration attempt did not produce a useful result.

![Virtual host discovery — evidence 1](assets/linkvortex/4_LinkVortex_image.jpg)

![Virtual host discovery — evidence 2](assets/linkvortex/7_LinkVortex_image.jpg)

## Exposed Git repository

Content enumeration of the development site revealed an exposed Git repository. The repository was recovered for offline inspection.

![Exposed Git repository — evidence 1](assets/linkvortex/8_LinkVortex_image.jpg)

![Exposed Git repository — evidence 2](assets/linkvortex/2_LinkVortex_image.jpg)

## Ghost CMS credentials

Searching the recovered source revealed hardcoded test credentials associated with Ghost authentication.

![Ghost CMS credentials — evidence 1](assets/linkvortex/LinkVortex_image.jpg)

## Authenticated file disclosure

CVE-2023-40028 enabled file disclosure within Ghost. The screenshots show the account listing and the production configuration, including credentials later used for host access.

![Authenticated file disclosure — evidence 1](assets/linkvortex/5_LinkVortex_image.jpg)

![Authenticated file disclosure — evidence 2](assets/linkvortex/6_LinkVortex_image.jpg)

## Host access and privileged file read

The SSH session as bob and inspection of the privileged cleanup script are recorded below. The script mishandled symbolic links, allowing a protected file to be read. The final screenshot documents the disclosed flag-like value, not an interactive root shell.

![Host access and privileged file read — evidence 1](assets/linkvortex/3_LinkVortex_image.jpg)

![Host access and privileged file read — evidence 2](assets/linkvortex/1_LinkVortex_image.jpg)

## References

- [Machine reference](https://www.hackthebox.com/machines/linkvortex)
