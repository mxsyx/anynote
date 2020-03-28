<template>
  <div id="sidebar">
    <FolderBox :level="level" :expand="true" :folders="folders" />
  </div>
</template>

<script>
import FolderBox from "./FolderBox";

export default {
  name: "TheSidebar",

  components: {
    FolderBox
  },

  data() {
    return {
      level: 0,
      folders: [
        {
          id: 1,
          level: 0,
          name: "编程语言",
          noteNum: 16,
          hasSubfolder: true,
          expand: false,
          subfolders: [
            {
              id: 88,
              level: 1,
              name: "静态语言",
              noteNum: 26,
              hasSubfolder: true,
              expand: false,
              subfolders: [
                {
                  id: 101,
                  level: 2,
                  name: "静态语言",
                  noteNum: 26,
                  hasSubfolder: false,
                  expand: false
                },
                {
                  id: 102,
                  level: 2,
                  name: "脚本语言",
                  noteNum: 26,
                  hasSubfolder: false,
                  expand: false
                },
                {
                  id: 103,
                  level: 2,
                  name: "标记语言",
                  noteNum: 26,
                  hasSubfolder: false,
                  expand: false
                }
              ]
            },
            {
              id: 89,
              level: 1,
              name: "脚本语言",
              noteNum: 26,
              hasSubfolder: true,
              expand: false
            },
            {
              id: 90,
              level: 1,
              name: "标记语言",
              noteNum: 26,
              hasSubfolder: true,
              expand: false,
              subfolders: [
                {
                  id: 101,
                  level: 2,
                  name: "静态语言",
                  noteNum: 26,
                  hasSubfolder: true,
                  expand: false,
                  subfolders: [
                    {
                      id: 101,
                      level: 3,
                      name: "静态语言",
                      noteNum: 26,
                      hasSubfolder: false,
                      expand: false
                    },
                    {
                      id: 102,
                      level: 3,
                      name: "脚本语言",
                      noteNum: 26,
                      hasSubfolder: false,
                      expand: false
                    },
                    {
                      id: 103,
                      level: 3,
                      name: "标记语言",
                      noteNum: 26,
                      hasSubfolder: false,
                      expand: false
                    }
                  ]
                },
                {
                  id: 102,
                  level: 2,
                  name: "脚本语言",
                  noteNum: 26,
                  hasSubfolder: false,
                  expand: false
                },
                {
                  id: 103,
                  level: 2,
                  name: "标记语言",
                  noteNum: 26,
                  hasSubfolder: false,
                  expand: false
                }
              ]
            }
          ]
        },
        {
          id: 2,
          level: 0,
          name: "网站技术",
          noteNum: 18,
          hasSubfolder: false,
          expand: false
        },
        {
          id: 3,
          level: 0,
          name: "数据科学",
          noteNum: 14,
          hasSubfolder: false,
          expand: false
        }
      ]
    };
  }
};
</script>

<style scoped>
#sidebar {
  background-image: url("../assets/sidebar-bg.jpg");
  background-size: 100% 100%;
}
</style>