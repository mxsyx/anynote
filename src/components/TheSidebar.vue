<template>
  <div id="sidebar">
    <FolderBox :level="level" :folders="folders"/>
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
          hasSubFolder: true,
          subFolderHeight: '0px',
          subFolders: [
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
        },
        {
          id: 3,
          name: '数据科学',
          noteNum: 14,
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