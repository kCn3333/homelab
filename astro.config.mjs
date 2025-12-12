import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://kcn3333.github.io',
  base: '/homelab',
  
  integrations: [
    starlight({
      title: 'kCn Homelab',
      description: 'Built with coffee, curiosity, and so much fun',
      
      //logo: {
        //src: './src/assets/logo.svg',
      //},
      
      social: {
        icon: 'github',
        label: 'GitHub',
        href: 'https://github.com/kCn3333/homelab',
      },
      
        //                    === Sidebar configuration ===
             
      sidebar: [
        //                      === Home ===
        {
          label: 'Home',
          icon: 'home',
          link: '/', 
        },

        //                      === Infrastructure ===
        {
          label: 'Infrastructure',
          icon: 'farcaster',
          items: [
            { autogenerate: { directory: 'infrastructure' } },                                      // directory
            { label: 'Project Server', icon: 'laptop', link: 'https://kcn333.pl/home_server' },      // link 
          ],
        },

        //                      === Provisioning ===
        {
          label: 'Provisioning',
          icon: 'rocket',
          autogenerate: { directory: 'provisioning' },
        },

        //                      === Applications ===
        {
          label: 'Applications',
          icon: 'seti:svg',
          items: [
            { label: 'Docker Compose Repo', icon: 'seti:docker', link: 'https://github.com/kCn3333/docker-compose' },
            { label: '.bashrc', icon: 'setting', link: 'https://github.com/kCn3333/linux-bash/blob/main/.bashrc' },
            { label: 'starship config', icon: 'setting', link: 'https://github.com/kCn3333/starship-config' },
            { label: 'wireshark config', icon: 'setting', link: 'https://github.com/kCn3333/wireshark' },
            {
              //             === Bash Scripts ===
              label: 'Bash Scripts',
              icon: 'forward-slash', 
              items: [
                { label: 'backup', icon: 'seti:powershell', link: 'https://github.com/kCn3333/linux-bash/tree/main/backup' },
                { label: 'db backup' , icon: 'seti:powershell', link: 'https://github.com/kCn3333/linux-bash/tree/main/db_backup'},
                { label: 'ssh login alert', icon: 'seti:powershell', link: 'https://github.com/kCn3333/linux-bash/tree/main/ssh_login_alert'},
                { label: 'temp monitor', icon: 'seti:powershell', link: 'https://github.com/kCn3333/linux-bash/tree/main/temp_monitor'}

              ],
            },
          ],
        },
        //                  === Automation ===
        {
          label: 'Automation',
          icon: 'seti:bicep',
          items: [
            { label: 'Ansible playbooks', icon: 'seti:video', autogenerate: { directory: 'automation' } },       // dir
            { label: 'n8n workflows', icon: 'seti:todo', link: 'https://github.com/kCn3333/n8n_workflows' },
          ],
        },
        
      ],
      //                    === custom CSS file ===
    customCss: [
     './src/styles/starlight-retro.css',
    ],
      //                    === dark theme for code blocks ===
      expressiveCode: {
        themes: ['dracula'],
      },
    }),
  ],
});