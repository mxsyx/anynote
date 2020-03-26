<template>
  <ul class="folder-box" :class="whichLevel">
    <li  v-for="(folder, index) in folders" :key="folder.id">
      <a class="folder">
        <i
          class="fa fa-angle-right folder-angle" 
          @click="toggleSubFolder(index)">
        </i>
        <span class="folder-name">{{ folder.name }}</span>
        <span class="note-num">{{ folder.noteNum }}</span>
      </a>
      <FolderBox
        v-if="folder.hasSubFolder"
        :style="{ maxHeight: folder.subFolderHeight}"
        :level="level + 1"
        :folders="folder.subFolders"
      />
    </li>
  </ul>
</template>

<script>
export default {
  name: 'FolderBox',

  props: {
    level: {
      type: Number,
      required: true
    },
    folders: {
      type: Array,
      required: true
    },
  },

  data() {
    return {
      showSubFolder: false,
    }
  },

  computed : {
    whichLevel() {
      return `level${this.level}`;
    }
  },

  methods: {
    toggleSubFolder(index) {

      this.folders[index].subFolderHeight = 
          this.folders[index].subFolderHeight == '0px' ? '300px' : '0px';
    }
  }
}
</script>

<style scoped>
.folder-box {
  overflow: hidden;
  transition: all 2s;
}

.folder {
  display: grid;
  grid-template-columns: 12% 68% 20%;
  grid-template-rows: 100%;
  color: #ffffff;
  padding: 0.8rem 0rem;
  cursor: pointer;
  user-select: none;
}
.folder:hover {
  font-weight: 800;
}

.folder-angle {
  text-align: center;
}

.folder-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.level0 {
  margin-left: 0rem;
  font-size: 1.5rem;
}

.level1 {
  margin-left: 1rem;
  font-size: 1.4rem;
}
</style>