const { withProjectBuildGradle } = require('expo/config-plugins');

const repository = `    maven {
      url new File(rootDir, '../node_modules/@utexo/rgb-sdk-rn/android/local-maven')
      content { includeGroup 'com.utexo.local' }
    }
`;

module.exports = (config) => withProjectBuildGradle(config, (project) => {
  if (!project.modResults.contents.includes("includeGroup 'com.utexo.local'")) {
    const anchor = 'allprojects {\n  repositories {\n';
    if (!project.modResults.contents.includes(anchor))
      throw new Error('Cannot find Android project repositories for the local BFA AAR');
    project.modResults.contents = project.modResults.contents.replace(anchor, anchor + repository);
  }
  return project;
});
