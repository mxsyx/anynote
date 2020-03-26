<template>
  <div id="sidebar">
    <FolderBox :level="level" :folders="folders" :display="true"/>
  </div>
</template>

<script>
import FolderBox from '@/components/FolderBox'

export default {
  name: 'TheSidebar',

  components: {
    FolderBox,
  },

  data() {
    return {
      level: 0,
      folders: [
        {
          id: 1,
          name: '编程语言',
          noteNum: 16,
          hasSubfolder: true,
          subfolders: [
            {
              id: 88,
              name: '静态语言',
              noteNum: 26,
            },
            {
              id: 89,
              name: '脚本语言',
              noteNum: 26,
            },
            {
              id: 90,
              name: '标记语言',
              noteNum: 26,
            }
          ]
        },
        {
          id: 2,
          name: '网站技术',
          noteNum: 18,
          subfolders: [
            {
              id: 91,
              name: '静态语言',
              noteNum: 26,
            },
            {
              id: 92,
              name: '脚本语言',
              noteNum: 26,
            },
            {
              id: 93,
              name: '标记语言',
              noteNum: 26,
            }
          ]
        },
        {
          id: 3,
          name: '数据科学',
          noteNum: 14,
          subfolders: [
            {
              id: 71,
              name: '静态语言',
              noteNum: 26,
            },
            {
              id: 72,
              name: '脚本语言',
              noteNum: 26,
            },
            {
              id: 73,
              name: '标记语言',
              noteNum: 26,
            }
          ]
        }
      ]
    }
  }
}
</script>

<style scoped>
#sidebar {
  background-image: url('../assets/sidebar-bg.jpg');
  background-size: 100% 100%;
}
</style>