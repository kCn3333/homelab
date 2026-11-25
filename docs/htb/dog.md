# Dog

**Platform:** :simple-hackthebox: Hack The Box<br>
**OS:** Linux<br>
**Lab date:** 2025-03-19

## Repository enumeration

An exposed Git repository provided application source, email addresses and a database credential in settings.php.

![Repository enumeration — evidence 1](assets/dog/Dog_image.jpg)

![Repository enumeration — evidence 2](assets/dog/4_Dog_image.jpg)

## Backdrop CMS access

The published machine solution confirms that credential reuse enabled administrative CMS access. The screenshots show preparation of a module and the authenticated installation interface.

![Backdrop CMS access — evidence 1](assets/dog/3_Dog_image.jpg)

![Backdrop CMS access — evidence 2](assets/dog/Dog_image.png)

## Web execution

The module installation succeeded. The resulting web interface returned the system account listing, including the local account johncusack.

![Web execution — evidence 1](assets/dog/1_Dog_image.png)

![Web execution — evidence 2](assets/dog/2_Dog_image.png)

![Web execution — evidence 3](assets/dog/2_Dog_image.jpg)

## Privilege escalation and root evidence

The local account reused the application credential for SSH. Its sudo permissions allowed the Backdrop Bee utility to execute code with elevated privileges. The final capture shows the root flag and an interactive root prompt, as well as unsuccessful intermediate attempts.

![Privilege escalation and root evidence — evidence 1](assets/dog/1_Dog_image.jpg)

## References

- [Machine reference](https://0xdf.gitlab.io/2025/07/12/htb-dog.html)
