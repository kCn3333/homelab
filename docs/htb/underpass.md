# UnderPass

**Platform:** :simple-hackthebox: Hack The Box 
**OS:** Linux 
**Lab date:** 2025-03-23

## TCP and UDP enumeration

The initial TCP scan identified SSH and HTTP. UDP enumeration and SNMP inspection identified the daloRADIUS service.

![TCP and UDP enumeration — evidence 1](assets/underpass/UnderPass_image.jpg)

![TCP and UDP enumeration — evidence 2](assets/underpass/1_UnderPass_image.jpg)

![TCP and UDP enumeration — evidence 3](assets/underpass/5_UnderPass_image.jpg)

## Web application discovery

Directory enumeration identified daloRADIUS resources, including an exposed Compose configuration.

![Web application discovery — evidence 1](assets/underpass/9_UnderPass_image.jpg)

![Web application discovery — evidence 2](assets/underpass/2_UnderPass_image.jpg)

![Web application discovery — evidence 3](assets/underpass/4_UnderPass_image.jpg)

## Operator access and credential recovery

The operator interface was accessible with default credentials. The svcMosh account record exposed a password hash, which was recovered using a hash lookup service.

![Operator access and credential recovery — evidence 1](assets/underpass/7_UnderPass_image.jpg)

![Operator access and credential recovery — evidence 2](assets/underpass/8_UnderPass_image.jpg)

## SSH access

The recovered credential enabled an SSH session as the service account. The sudo listing identified a privileged Mosh server executable.

![SSH access — evidence 1](assets/underpass/3_UnderPass_image.jpg)

![SSH access — evidence 2](assets/underpass/11_UnderPass_image.jpg)

## Root access

The Mosh permission allowed a privileged session. The final screenshot shows a root prompt and successful reading of root.txt.

![Root access — evidence 1](assets/underpass/6_UnderPass_image.jpg)

![Root access — evidence 2](assets/underpass/10_UnderPass_image.jpg)

## References

- [Machine reference](https://www.hackthebox.com/machines/underpass)
